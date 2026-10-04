/** Decimal strings are canonical base-10 integers; cash adapters use bounded naturals. */
export type Decimal = string;

/** Canonical identity and units, never an implicitly inferred vendor symbol mapping. */
export interface Instrument {
  readonly symbol: string;
  readonly currency: string;
  readonly lotSize: string;
  readonly priceTick?: Decimal;
}

export interface AdapterManifest {
  readonly id: string;
  readonly datasetHash?: string;
  readonly configHash?: string;
  readonly [key: string]: unknown;
}

export interface Observation<Data = Record<string, unknown>> {
  readonly time: Decimal;
  readonly availableAt: Decimal;
  readonly data: Readonly<Data>;
}

export interface InformationSource<Data = Record<string, unknown>> {
  readonly instrument: Instrument;
  readonly manifest: AdapterManifest;
  observations(): Iterable<Observation<Data>>;
}

/** Prepared sources own disk cursors; close after all replays finish. */
export interface PreparedInformationSource<Data = Record<string, unknown>> extends InformationSource<Data> {
  close(): void;
}

export interface RecordingOptions {
  /** Exclusive new directory. Summary reports reference the complete indexed audit. */
  auditDirectory?: string;
}

export interface ReportOptions {
  /** Explicit full materialization can use memory proportional to the entire run. */
  detail?: 'summary' | 'full';
}

export interface WorkingOrder {
  readonly id: bigint | string;
  readonly side: 'buy' | 'sell';
  readonly limit: bigint | Decimal;
  readonly remaining: bigint | Decimal;
  readonly cancellationPending: boolean;
}

export interface AccountSnapshot {
  readonly ledger: { readonly cash: bigint | Decimal; readonly quantity: bigint | Decimal };
  readonly orders: readonly WorkingOrder[];
  /** Venue valuation, including venue-specific funding/margin accounting; null if invalid. */
  readonly equity: bigint | Decimal | null;
  readonly funding: Readonly<Record<string, unknown>>;
  readonly margin: Readonly<Record<string, unknown>>;
}

/** Synchronous replay interface. Use a fresh venue per run; do not consume future events. */
export interface ExecutionVenue<Report = Record<string, unknown>> {
  readonly instrument: Instrument;
  readonly manifest: AdapterManifest;
  advanceTo(time: Decimal): void;
  snapshot(): AccountSnapshot;
  /** Signed intent; cash venues reject negatives. Venue owns admission and orders. */
  setTarget(target: Decimal, time: Decimal): void;
  /** End at this time (null for an empty source), with no implicit liquidation. */
  finish(time: Decimal | null): void;
  report(options?: ReportOptions): Report;
  /** Release incomplete recording if the strategy or source fails. */
  abort?(): void;
}

export interface StrategyContext<Data = Record<string, unknown>> {
  readonly observation: Readonly<Data>;
  readonly history: readonly Readonly<Data>[];
  readonly time: Decimal;
  readonly index: number;
  readonly tickCount: number;
  readonly account: AccountSnapshot;
  readonly ledger: AccountSnapshot['ledger'];
  readonly orders: AccountSnapshot['orders'];
  readonly equity: AccountSnapshot['equity'];
}

/** null skips reconciliation; '0' requests flat; negatives request short exposure. */
export type Strategy<Data = Record<string, unknown>> = ((context: StrategyContext<Data>) => Decimal | null) & {
  /** Default and minimum visible history; use replay lookback: 'all' for full history. */
  readonly lookback?: number;
};

/** Data preparation does not construct or select an ExecutionVenue. */
export type MarketDataKind = 'bars' | 'bookTicker' | 'trades' | 'markPrice' | 'indexPrice' | 'premium' | 'funding';
export type FundingContract =
  | { source: 'binance-archive'; rateRole: 'archive' | 'realized'; publicationTime: 'settlement-assumption' }
  | { source: 'okx-archive' | 'okx-history'; rateRole: 'archive' | 'realized'; publicationTime: 'ts' | 'settlement-assumption' }
  | { source: 'okx-current'; rateRole: 'predicted'; publicationTime: 'ts' };
interface MarketDataConfigurationBase {
  venue: 'binance' | 'okx';
  manifestPath: string;
  startTime: Decimal;
  endTime: Decimal;
  publicationDelayMs?: Decimal;
  /** Exact decimal ETH per contract; explicitly pinned for OKX trades/books. */
  contractSizeETH?: string;
}
export type MarketDataConfiguration = MarketDataConfigurationBase & (
  | { kind: 'funding'; funding: FundingContract }
  | { kind: Exclude<MarketDataKind, 'funding'>; funding?: never }
);
export interface MarketDataSource {
  readonly manifest: Readonly<Record<string, unknown>>;
  records(): AsyncIterable<Observation>;
}
export interface ProcessedDataSelection {
  manifestPath: string;
  startTime?: Decimal;
  endTime?: Decimal;
  allowGaps?: boolean;
}

export interface ProcessedInformationSelection extends ProcessedDataSelection {
  /** Stream admission into a new directory instead of collecting an array. */
  directory?: string;
  /** Applies only to in-memory preparation; cannot be combined with directory. */
  maxRows?: number;
}

export interface ExactRate { numerator: Decimal; denominator: Decimal; }
export interface DerivativeWindow { startTime: Decimal; endTime: Decimal; }
