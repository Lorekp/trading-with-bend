import { CanonicalArrayHash, canonical, freeze, immutableCopy, requireThat } from './core.mjs';
import { validateQuoteTick, validateTicks } from './data.mjs';
import { ReplayRecording, openReplayAudit } from './recording.mjs';

const admitted = new WeakSet();
export function isQuoteDataset(value) { return value && typeof value === 'object' && admitted.has(value); }
export function assertQuoteInstrument(dataset, instrument) {
  requireThat(canonical(dataset.instrument) === canonical(instrument),'UNIT_MISMATCH','Admitted quotes use a different instrument or units');
}

/** Admit once, before strategy execution; both adapters can read independent
 * bounded cursors. The caller owns close() after all replays finish.
 */
export async function prepareQuoteData(ticks, { instrument, directory }) {
  validateTicks([], {instrument}); // Validate even an empty stream, before creating files.
  requireThat(ticks && (ticks[Symbol.iterator] || ticks[Symbol.asyncIterator]),'DATA_SCHEMA','Quotes must be iterable');
  const recording = new ReplayRecording(directory);
  requireThat(recording.disk,'DATA_DIRECTORY','Quote preparation requires a new directory');
  const records = recording.series('quotes'), identities = recording.map('quote-identities'), observations = new CanonicalArrayHash();
  let previousTime = null, previousSequence = null;
  try {
    for await (const input of ticks) {
      const tick = immutableCopy(input), values = validateQuoteTick(tick,instrument,records.length);
      requireThat(!identities.has(tick.id),'DATA_DUPLICATE',`Duplicate quote ID: ${tick.id}`);
      requireThat(previousTime === null || values.time >= previousTime,'OUT_OF_ORDER','Input quote timestamps must not decrease');
      requireThat(previousSequence === null || values.sequence > previousSequence,'OUT_OF_ORDER','Input quote sequence numbers must strictly increase');
      recording.transaction(()=>{records.push(tick); identities.set(tick.id,true);});
      observations.push({time:tick.sourceTime,availableAt:tick.time,data:tick});
      previousTime=values.time; previousSequence=values.sequence;
    }
    const audit = recording.seal({kind:'quote-dataset',instrument:structuredClone(instrument),observationsHash:observations.digest()});
    return openQuoteData(audit);
  } catch(error) { recording.abort(); throw error; }
}

export function openQuoteData(input) {
  const audit=openReplayAudit(input), metadata=audit.manifest.metadata;
  try {
    requireThat(metadata?.kind==='quote-dataset','DATA_SCHEMA','Expected admitted quote data');
    const dataset=Object.freeze({instrument:freeze(metadata.instrument),
      manifest:freeze({datasetHash:audit.manifest.streams.quotes.hash,observationsHash:metadata.observationsHash,audit:audit.manifest}),
      rows:()=>audit.records('quotes'), hasId:id=>audit.has('quote-identities',id), close:()=>audit.close()});
    admitted.add(dataset); return dataset;
  } catch(error) {audit.close();throw error;}
}
