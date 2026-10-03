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
  report(): Report;
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
