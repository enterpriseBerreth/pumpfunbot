import WebSocket from 'ws';
import { CONFIG } from './config.js';
import { TokenCandidate, PumpFunNewToken, PumpFunTrade } from './types.js';
import { log } from './logger.js';

const MODULE = 'SCANNER';

// ── SOL price tracking ──

let solPriceUsd = 150; // Fallback, updated at runtime

export function getSolPrice(): number {
  return solPriceUsd;
}

export async function updateSolPrice(): Promise<number> {
  // Try multiple sources for reliability
  const sources: Array<{ name: string; fetch: () => Promise<number> }> = [
    {
      name: 'Jupiter',
      fetch: async () => {
        const res = await fetch(`${CONFIG.JUPITER_PRICE_API}?ids=${CONFIG.SOL_MINT}`, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return 0;
        const data = (await res.json()) as { data: Record<string, { price: string } | undefined> };
        return parseFloat(data.data[CONFIG.SOL_MINT]?.price || '0');
      },
    },
    {
      name: 'CoinGecko',
      fetch: async () => {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return 0;
        const data = (await res.json()) as { solana?: { usd?: number } };
        return data.solana?.usd ?? 0;
      },
    },
    {
      name: 'Binance',
      fetch: async () => {
        const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return 0;
        const data = (await res.json()) as { price?: string };
        return parseFloat(data.price || '0');
      },
    },
  ];

  for (const src of sources) {
    try {
      const price = await src.fetch();
      if (price > 0) {
        solPriceUsd = price;
        log.info(MODULE, `SOL price updated via ${src.name}: $${price.toFixed(2)}`);
        return solPriceUsd;
      }
    } catch { /* try next */ }
  }

  log.warn(MODULE, `All SOL price sources failed, using $${solPriceUsd.toFixed(2)}`);
  return solPriceUsd;
}

// ── Jupiter price lookup for tokens ──

export async function fetchTokenPriceUsd(mint: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${CONFIG.JUPITER_PRICE_API}?ids=${mint}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { data: Record<string, { price: string } | undefined> };
    const price = parseFloat(data.data[mint]?.price || '0');
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

export async function fetchMultipleTokenPrices(mints: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (mints.length === 0) return prices;

  try {
    const ids = mints.join(',');
    const res = await fetch(
      `${CONFIG.JUPITER_PRICE_API}?ids=${ids}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return prices;
    const data = (await res.json()) as { data: Record<string, { price: string } | undefined> };
    for (const [mint, info] of Object.entries(data.data)) {
      if (info?.price) {
        const p = parseFloat(info.price);
        if (p > 0) prices.set(mint, p);
      }
    }
  } catch { /* best effort */ }

  return prices;
}

// ── Main Scanner Class ──

export class PumpFunScanner {
  private ws: WebSocket | null = null;
  private candidates = new Map<string, TokenCandidate>();
  private reconnectDelay: number = CONFIG.WS_RECONNECT_DELAY_MS;
  private shouldRun = false;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private solPriceInterval: ReturnType<typeof setInterval> | null = null;
  private subscribedTokens = new Set<string>();

  // Callback when a token qualifies for buying
  onQualifiedToken: ((candidate: TokenCandidate) => void) | null = null;
  // Callback for price updates on tokens we hold
  onPriceUpdate: ((mint: string, priceSol: number, priceUsd: number, marketCapSol: number) => void) | null = null;

  async start(): Promise<void> {
    this.shouldRun = true;

    // Fetch SOL price with retries - critical for accurate USD values
    for (let i = 0; i < 5; i++) {
      const price = await updateSolPrice();
      if (price !== 150) break; // Got a real price, not the fallback
      if (i < 4) {
        log.warn(MODULE, `SOL price fetch attempt ${i + 1} failed, retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }

    // Periodically update SOL price
    this.solPriceInterval = setInterval(() => updateSolPrice(), 60_000);

    // Periodically clean up stale candidates
    this.cleanupInterval = setInterval(() => this.cleanupCandidates(), 30_000);

    // Connect to WebSocket
    this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.solPriceInterval) {
      clearInterval(this.solPriceInterval);
      this.solPriceInterval = null;
    }
    log.info(MODULE, 'Scanner stopped');
  }

  // Subscribe to trade events for a specific token (used after buying)
  subscribeToToken(mint: string): void {
    if (this.subscribedTokens.has(mint)) return;
    this.subscribedTokens.add(mint);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        method: 'subscribeTokenTrade',
        keys: [mint],
      }));
      log.info(MODULE, `Subscribed to trades for ${mint.slice(0, 8)}...`);
    }
  }

  unsubscribeFromToken(mint: string): void {
    this.subscribedTokens.delete(mint);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        method: 'unsubscribeTokenTrade',
        keys: [mint],
      }));
    }
  }

  getCandidateCount(): number {
    return this.candidates.size;
  }

  // ── WebSocket Connection ──

  private connect(): void {
    if (!this.shouldRun) return;

    log.info(MODULE, `Connecting to PumpPortal WebSocket...`);

    this.ws = new WebSocket(CONFIG.PUMPFUN_WS_URL);

    this.ws.on('open', () => {
      log.success(MODULE, 'Connected to PumpPortal WebSocket');
      this.reconnectDelay = CONFIG.WS_RECONNECT_DELAY_MS;

      // Subscribe to new token creation events
      this.ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
      log.info(MODULE, 'Subscribed to new token events');

      // Re-subscribe to any tokens we were tracking
      for (const mint of this.subscribedTokens) {
        this.ws!.send(JSON.stringify({
          method: 'subscribeTokenTrade',
          keys: [mint],
        }));
      }

      // Subscribe to trades for all active candidates
      const candidateMints = Array.from(this.candidates.keys()).filter(
        (m) => !this.subscribedTokens.has(m)
      );
      if (candidateMints.length > 0) {
        this.ws!.send(JSON.stringify({
          method: 'subscribeTokenTrade',
          keys: candidateMints,
        }));
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on('error', (err: Error) => {
      log.error(MODULE, `WebSocket error: ${err.message}`);
    });

    this.ws.on('close', () => {
      log.warn(MODULE, 'WebSocket disconnected');
      if (this.shouldRun) {
        log.info(MODULE, `Reconnecting in ${this.reconnectDelay / 1000}s...`);
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 1.5,
          CONFIG.WS_MAX_RECONNECT_DELAY_MS
        );
      }
    });
  }

  // ── Message Handler ──

  private handleMessage(msg: Record<string, unknown>): void {
    // New token creation event
    if ('mint' in msg && 'initialBuy' in msg && 'traderPublicKey' in msg && 'name' in msg) {
      this.handleNewToken(msg as unknown as PumpFunNewToken);
      return;
    }

    // Trade event
    if ('mint' in msg && 'txType' in msg && 'traderPublicKey' in msg && 'signature' in msg) {
      this.handleTrade(msg as unknown as PumpFunTrade);
      return;
    }
  }

  // ── New Token Handler ──

  private handleNewToken(token: PumpFunNewToken): void {
    if (this.candidates.has(token.mint)) return;

    const priceSol = token.marketCapSol / CONFIG.PUMPFUN_TOTAL_SUPPLY;
    const priceUsd = priceSol * solPriceUsd;

    const candidate: TokenCandidate = {
      mint: token.mint,
      name: token.name,
      symbol: token.symbol,
      devWallet: token.traderPublicKey,
      createdAt: Date.now(),
      uniqueBuyers: new Set<string>(),
      buyCount: 0,
      sellCount: 0,
      latestMarketCapSol: token.marketCapSol,
      latestPriceSol: priceSol,
      latestPriceUsd: priceUsd,
      totalBuyVolumeSol: 0,
      lastTradeAt: Date.now(),
      qualified: false,
    };

    // If dev made an initial buy, don't count them as a unique buyer
    if (token.initialBuy > 0) {
      candidate.buyCount = 1; // Dev's buy
    }

    this.candidates.set(token.mint, candidate);

    log.info(
      MODULE,
      `New token: ${token.symbol} (${token.name}) | Mint: ${token.mint.slice(0, 8)}... | Dev: ${token.traderPublicKey.slice(0, 8)}... | MCap: ${token.marketCapSol.toFixed(2)} SOL`
    );

    // Subscribe to trades for this token
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        method: 'subscribeTokenTrade',
        keys: [token.mint],
      }));
    }
  }

  // ── Trade Handler ──

  private handleTrade(trade: PumpFunTrade): void {
    const priceSol = trade.marketCapSol / CONFIG.PUMPFUN_TOTAL_SUPPLY;
    const priceUsd = priceSol * solPriceUsd;

    // Update price for held positions
    this.onPriceUpdate?.(trade.mint, priceSol, priceUsd, trade.marketCapSol);

    // Update candidate tracking
    const candidate = this.candidates.get(trade.mint);
    if (!candidate || candidate.qualified) return;

    // Update price data
    candidate.latestMarketCapSol = trade.marketCapSol;
    candidate.latestPriceSol = priceSol;
    candidate.latestPriceUsd = priceUsd;
    candidate.lastTradeAt = Date.now();

    if (trade.txType === 'buy') {
      candidate.buyCount++;

      // Track unique buyers EXCLUDING the developer wallet
      if (trade.traderPublicKey !== candidate.devWallet) {
        candidate.uniqueBuyers.add(trade.traderPublicKey);
      }

      // Estimate buy volume from bonding curve changes
      // solAmount isn't directly in the event, estimate from market cap change
      candidate.totalBuyVolumeSol += Math.abs(
        trade.marketCapSol - candidate.latestMarketCapSol
      ) || 0.01;
    } else {
      candidate.sellCount++;
    }

    // ── Check qualification ──
    const ageSec = (Date.now() - candidate.createdAt) / 1000;
    const uniqueBuyerCount = candidate.uniqueBuyers.size;

    if (
      !candidate.qualified &&
      uniqueBuyerCount >= CONFIG.MIN_UNIQUE_BUYERS &&
      ageSec >= CONFIG.MIN_TOKEN_AGE_SECONDS &&
      ageSec <= CONFIG.MAX_TOKEN_AGE_SECONDS
    ) {
      candidate.qualified = true;

      log.success(
        MODULE,
        `QUALIFIED: ${candidate.symbol} | Buyers: ${uniqueBuyerCount} (excl. dev) | Age: ${ageSec.toFixed(0)}s | MCap: ${candidate.latestMarketCapSol.toFixed(2)} SOL ($${(candidate.latestMarketCapSol * solPriceUsd).toFixed(0)})`
      );

      this.onQualifiedToken?.(candidate);
    }
  }

  // ── Cleanup ──

  private cleanupCandidates(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (const [mint, candidate] of this.candidates) {
      if (candidate.qualified) continue;

      const age = now - candidate.createdAt;
      if (age > CONFIG.CANDIDATE_TIMEOUT_MS) {
        expired.push(mint);
      }
    }

    if (expired.length > 0) {
      for (const mint of expired) {
        this.candidates.delete(mint);
        // Unsubscribe from trades if not in our held positions
        if (!this.subscribedTokens.has(mint) && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            method: 'unsubscribeTokenTrade',
            keys: [mint],
          }));
        }
      }
      log.info(MODULE, `Cleaned up ${expired.length} expired candidate(s) | Active: ${this.candidates.size}`);
    }
  }
}
