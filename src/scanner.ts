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
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private subscribedTokens = new Set<string>();
  private hasApiKey: boolean;
  private totalScanned = 0;

  // Callback when a token qualifies for buying
  onQualifiedToken: ((candidate: TokenCandidate) => void) | null = null;
  // Callback for price updates on tokens we hold
  onPriceUpdate: ((mint: string, priceSol: number, priceUsd: number, marketCapSol: number) => void) | null = null;

  constructor() {
    this.hasApiKey = CONFIG.PUMPPORTAL_API_KEY.length > 0;
  }

  async start(): Promise<void> {
    this.shouldRun = true;

    if (this.hasApiKey) {
      log.success(MODULE, 'PumpPortal API key detected — using real-time trade events');
    } else {
      log.warn(MODULE, 'No PumpPortal API key — using HTTP polling for trade data (free mode)');
    }

    // Fetch SOL price with retries
    for (let i = 0; i < 5; i++) {
      const price = await updateSolPrice();
      if (price !== 150) break;
      if (i < 4) {
        log.warn(MODULE, `SOL price fetch attempt ${i + 1} failed, retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }

    // Periodically update SOL price
    this.solPriceInterval = setInterval(() => updateSolPrice(), 60_000);

    // Periodically clean up stale candidates
    this.cleanupInterval = setInterval(() => this.cleanupCandidates(), 30_000);

    // If no API key, start polling loop for trade data
    if (!this.hasApiKey) {
      this.startPolling();
    }

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
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    log.info(MODULE, 'Scanner stopped');
  }

  subscribeToToken(mint: string): void {
    if (this.subscribedTokens.has(mint)) return;
    this.subscribedTokens.add(mint);
    if (this.hasApiKey && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        method: 'subscribeTokenTrade',
        keys: [mint],
      }));
      log.info(MODULE, `Subscribed to trades for ${mint.slice(0, 8)}...`);
    }
  }

  unsubscribeFromToken(mint: string): void {
    this.subscribedTokens.delete(mint);
    if (this.hasApiKey && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        method: 'unsubscribeTokenTrade',
        keys: [mint],
      }));
    }
  }

  getCandidateCount(): number {
    return this.candidates.size;
  }

  getTotalScanned(): number {
    return this.totalScanned;
  }

  // ── WebSocket Connection ──

  private connect(): void {
    if (!this.shouldRun) return;

    // Include API key in URL if available
    const wsUrl = this.hasApiKey
      ? `${CONFIG.PUMPFUN_WS_URL}?api-key=${CONFIG.PUMPPORTAL_API_KEY}`
      : CONFIG.PUMPFUN_WS_URL;

    log.info(MODULE, `Connecting to PumpPortal WebSocket...`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      log.success(MODULE, 'Connected to PumpPortal WebSocket');
      this.reconnectDelay = CONFIG.WS_RECONNECT_DELAY_MS;

      // Always subscribe to new token creation events (free)
      this.ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
      log.info(MODULE, 'Subscribed to new token events');

      // Only subscribe to trade events if we have an API key (paid feature)
      if (this.hasApiKey) {
        for (const mint of this.subscribedTokens) {
          this.ws!.send(JSON.stringify({
            method: 'subscribeTokenTrade',
            keys: [mint],
          }));
        }

        const candidateMints = Array.from(this.candidates.keys()).filter(
          (m) => !this.subscribedTokens.has(m)
        );
        if (candidateMints.length > 0) {
          this.ws!.send(JSON.stringify({
            method: 'subscribeTokenTrade',
            keys: candidateMints,
          }));
        }
      }
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch { /* Ignore malformed messages */ }
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

    // Trade event (only received with API key)
    if ('mint' in msg && 'txType' in msg && 'traderPublicKey' in msg && 'signature' in msg) {
      this.handleTrade(msg as unknown as PumpFunTrade);
      return;
    }
  }

  // ── New Token Handler ──

  private handleNewToken(token: PumpFunNewToken): void {
    if (this.candidates.has(token.mint)) return;

    this.totalScanned++;
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

    if (token.initialBuy > 0) {
      candidate.buyCount = 1;
    }

    this.candidates.set(token.mint, candidate);

    log.info(
      MODULE,
      `New token: ${token.symbol} (${token.name}) | Mint: ${token.mint.slice(0, 8)}... | Dev: ${token.traderPublicKey.slice(0, 8)}... | MCap: ${token.marketCapSol.toFixed(2)} SOL`
    );

    // Only subscribe to trade events via WS if we have an API key
    if (this.hasApiKey && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        method: 'subscribeTokenTrade',
        keys: [token.mint],
      }));
    }
  }

  // ── Trade Handler (WebSocket mode with API key) ──

  private handleTrade(trade: PumpFunTrade): void {
    const priceSol = trade.marketCapSol / CONFIG.PUMPFUN_TOTAL_SUPPLY;
    const priceUsd = priceSol * solPriceUsd;

    // Update price for held positions
    this.onPriceUpdate?.(trade.mint, priceSol, priceUsd, trade.marketCapSol);

    const candidate = this.candidates.get(trade.mint);
    if (!candidate || candidate.qualified) return;

    candidate.latestMarketCapSol = trade.marketCapSol;
    candidate.latestPriceSol = priceSol;
    candidate.latestPriceUsd = priceUsd;
    candidate.lastTradeAt = Date.now();

    if (trade.txType === 'buy') {
      candidate.buyCount++;
      if (trade.traderPublicKey !== candidate.devWallet) {
        candidate.uniqueBuyers.add(trade.traderPublicKey);
      }
      candidate.totalBuyVolumeSol += Math.abs(
        trade.marketCapSol - candidate.latestMarketCapSol
      ) || 0.01;
    } else {
      candidate.sellCount++;
    }

    this.checkQualification(candidate);
  }

  // ── HTTP Polling Mode (no API key) ──

  private startPolling(): void {
    log.info(MODULE, `Starting HTTP polling every ${CONFIG.POLL_INTERVAL_MS / 1000}s for trade data`);
    this.pollInterval = setInterval(() => this.pollCandidates(), CONFIG.POLL_INTERVAL_MS);
  }

  private async pollCandidates(): Promise<void> {
    const now = Date.now();
    const toCheck: TokenCandidate[] = [];

    for (const [, candidate] of this.candidates) {
      if (candidate.qualified) continue;
      const ageSec = (now - candidate.createdAt) / 1000;
      // Only poll tokens old enough and not too old
      if (ageSec >= CONFIG.MIN_TOKEN_AGE_SECONDS && ageSec <= CONFIG.MAX_TOKEN_AGE_SECONDS) {
        toCheck.push(candidate);
      }
    }

    // Also poll held positions for price updates
    const heldMints = Array.from(this.subscribedTokens);

    // Poll candidates (batch up to 5 at a time to avoid rate limits)
    const batch = toCheck.slice(0, 5);
    const promises: Promise<void>[] = [];

    for (const candidate of batch) {
      promises.push(this.pollTokenTrades(candidate));
    }

    // Poll held positions for price updates
    for (const mint of heldMints) {
      promises.push(this.pollTokenPrice(mint));
    }

    await Promise.allSettled(promises);
  }

  private async pollTokenTrades(candidate: TokenCandidate): Promise<void> {
    try {
      // Try Pump.fun Frontend API first
      const trades = await this.fetchPumpFunTrades(candidate.mint);
      if (trades !== null) {
        // Count unique buyers excluding dev
        const uniqueBuyers = new Set<string>();
        let latestMcap = candidate.latestMarketCapSol;

        for (const trade of trades) {
          if (trade.is_buy && trade.user !== candidate.devWallet) {
            uniqueBuyers.add(trade.user);
          }
          // Update price from most recent trade
          if (trade.sol_amount && trade.token_amount) {
            // Use the last trade's data for market cap
            latestMcap = trade.market_cap || latestMcap;
          }
        }

        candidate.uniqueBuyers = uniqueBuyers;
        candidate.buyCount = trades.filter((t: PumpFunApiTrade) => t.is_buy).length;
        candidate.sellCount = trades.filter((t: PumpFunApiTrade) => !t.is_buy).length;

        if (latestMcap > 0) {
          candidate.latestMarketCapSol = latestMcap;
          candidate.latestPriceSol = latestMcap / CONFIG.PUMPFUN_TOTAL_SUPPLY;
          candidate.latestPriceUsd = candidate.latestPriceSol * solPriceUsd;
        }

        this.checkQualification(candidate);
        return;
      }

      // Fallback: DexScreener
      const dexData = await this.fetchDexScreenerData(candidate.mint);
      if (dexData) {
        candidate.latestPriceUsd = dexData.priceUsd;
        candidate.latestPriceSol = dexData.priceUsd / solPriceUsd;
        // Use txn count as proxy for unique buyers (rough estimate)
        if (dexData.buyTxns >= CONFIG.MIN_UNIQUE_BUYERS) {
          // DexScreener doesn't give unique wallets, but buy txn count is a decent proxy
          for (let i = candidate.uniqueBuyers.size; i < dexData.buyTxns; i++) {
            candidate.uniqueBuyers.add(`dex-buyer-${i}`);
          }
        }
        this.checkQualification(candidate);
      }
    } catch (err) {
      // Silently ignore polling errors for individual tokens
    }
  }

  private async pollTokenPrice(mint: string): Promise<void> {
    try {
      // Try Pump.fun API for coin data
      const coinData = await this.fetchPumpFunCoin(mint);
      if (coinData && coinData.market_cap > 0) {
        const priceSol = coinData.market_cap / CONFIG.PUMPFUN_TOTAL_SUPPLY;
        const priceUsd = priceSol * solPriceUsd;
        this.onPriceUpdate?.(mint, priceSol, priceUsd, coinData.market_cap);
        return;
      }

      // Fallback: DexScreener
      const dexData = await this.fetchDexScreenerData(mint);
      if (dexData && dexData.priceUsd > 0) {
        const priceSol = dexData.priceUsd / solPriceUsd;
        this.onPriceUpdate?.(mint, priceSol, dexData.priceUsd, 0);
      }
    } catch { /* best effort */ }
  }

  // ── Pump.fun Frontend API ──

  private async fetchPumpFunTrades(mint: string): Promise<PumpFunApiTrade[] | null> {
    try {
      const url = `${CONFIG.PUMPFUN_API_BASE}/trades/all/${mint}?limit=50&minimumSize=0`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  }

  private async fetchPumpFunCoin(mint: string): Promise<{ market_cap: number; usd_market_cap?: number } | null> {
    try {
      const url = `${CONFIG.PUMPFUN_API_BASE}/coins/${mint}`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) return null;
      const data = await res.json() as Record<string, unknown>;
      return {
        market_cap: Number(data.market_cap ?? 0),
        usd_market_cap: Number(data.usd_market_cap ?? 0),
      };
    } catch {
      return null;
    }
  }

  // ── DexScreener Fallback ──

  private async fetchDexScreenerData(mint: string): Promise<{ priceUsd: number; buyTxns: number; sellTxns: number } | null> {
    try {
      const url = `${CONFIG.DEXSCREENER_API_BASE}/tokens/v1/solana/${mint}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const pairs = await res.json() as Array<Record<string, unknown>>;
      if (!Array.isArray(pairs) || pairs.length === 0) return null;

      const pair = pairs[0];
      const priceUsd = parseFloat(String(pair.priceUsd ?? '0'));
      const txns = pair.txns as Record<string, { buys?: number; sells?: number }> | undefined;
      const m5 = txns?.m5 ?? txns?.h1 ?? { buys: 0, sells: 0 };

      return {
        priceUsd,
        buyTxns: m5.buys ?? 0,
        sellTxns: m5.sells ?? 0,
      };
    } catch {
      return null;
    }
  }

  // ── Qualification Check ──

  private checkQualification(candidate: TokenCandidate): void {
    if (candidate.qualified) return;

    const ageSec = (Date.now() - candidate.createdAt) / 1000;
    const uniqueBuyerCount = candidate.uniqueBuyers.size;

    if (
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
        if (this.hasApiKey && !this.subscribedTokens.has(mint) && this.ws?.readyState === WebSocket.OPEN) {
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

// ── Pump.fun API trade type ──
interface PumpFunApiTrade {
  signature: string;
  mint: string;
  sol_amount: number;
  token_amount: number;
  is_buy: boolean;
  user: string;
  timestamp: number;
  tx_index: number;
  username?: string;
  profile_image?: string;
  slot: number;
  market_cap?: number;
}
