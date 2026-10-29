// Types/quality facts were measured from the pinned file with local DuckDB.
// Meanings: https://www.nyc.gov/assets/tlc/downloads/pdf/data_dictionary_trip_records_yellow.pdf
// The dictionary is newer than the file: do not backdate newly added fields/codes.
// These are metadata and synthetic SQL definitions, NEVER records or sampled values.
export const ESSENTIAL_SCHEMA = `Dataset: NYC yellow taxi trips, nominal January 2022.
Only table/view: trips. Exact verified DuckDB schema:
VendorID BIGINT
tpep_pickup_datetime TIMESTAMP
tpep_dropoff_datetime TIMESTAMP
passenger_count DOUBLE
trip_distance DOUBLE
RatecodeID DOUBLE
store_and_fwd_flag VARCHAR
PULocationID BIGINT
DOLocationID BIGINT
payment_type BIGINT
fare_amount DOUBLE
extra DOUBLE
mta_tax DOUBLE
tip_amount DOUBLE
tolls_amount DOUBLE
improvement_surcharge DOUBLE
total_amount DOUBLE
congestion_surcharge DOUBLE
airport_fee DOUBLE
All fields are nullable in the schema. No other columns, tables or lookups exist.
Timestamps are timezone-naive, not UTC-adjusted. The file includes out-of-month pickups.
Use all file records unless the question explicitly requests a date range or filters.
Do not guess undocumented category mappings. No dataset rows are provided.`;

export type Snippet = { id: string; keywords: readonly string[]; text: string };

export const DOCUMENTATION: readonly Snippet[] = [
  {
    id: 'payments',
    keywords: ['payment', 'payments', 'paid', 'pay', 'credit', 'card', 'cards', 'cash', 'method', 'dispute', 'voided'],
    text: 'payment_type is a categorical BIGINT: 1=credit card, 2=cash, 3=no charge, 4=dispute, 5=unknown, 6=voided. Code 0 occurs but its historical meaning is not established here; do not call it cash or credit card. Credit-card trip count uses WHERE payment_type = 1; cash uses = 2. A percentage needs an explicit denominator; all trips means COUNT(*) without silently excluding codes.',
  },
  {
    id: 'dates',
    keywords: ['date', 'dates', 'january', '2022', 'month', 'months', 'day', 'daily', 'hour', 'hourly', 'time', 'timestamp', 'pickup', 'pickups', 'dropoff', 'duration', 'minutes', 'long'],
    text: "tpep_pickup_datetime is meter engagement; tpep_dropoff_datetime is disengagement. Use naive timestamps as stored, without timezone conversion. For pickups in January 2022 use tpep_pickup_datetime >= TIMESTAMP '2022-01-01' AND tpep_pickup_datetime < TIMESTAMP '2022-02-01'. Daily grouping can use CAST(tpep_pickup_datetime AS DATE); hour() and date_trunc() are supported. Duration in minutes: date_diff('second', tpep_pickup_datetime, tpep_dropoff_datetime)/60.0. Exclude reversed times when measuring valid duration, and explain duration caps if requested. Do not pretend one nominal month supports year-over-year comparisons.",
  },
  {
    id: 'distance',
    keywords: ['distance', 'distances', 'miles', 'mile', 'kilometers', 'km', 'shortest', 'longest', 'speed'],
    text: 'trip_distance is taximeter-reported miles, not kilometers. Average positive trip distance uses AVG(trip_distance) WHERE trip_distance > 0. Do not silently apply that filter to a question asking for all records. Avoid division by zero in fare-per-mile calculations using NULLIF(trip_distance,0); explicitly require positive distance when appropriate.',
  },
  {
    id: 'fares',
    keywords: ['fare', 'fares', 'charge', 'charged', 'amount', 'total', 'revenue', 'cost', 'price', 'surcharge', 'tolls', 'tax', 'airport', 'fee'],
    text: 'Monetary columns are DOUBLE dollar amounts. fare_amount is the metered time-and-distance fare; total_amount is the recorded total passenger charge, excluding unrecorded cash tips. They are different metrics. extra holds miscellaneous extras; mta_tax, tolls_amount, improvement_surcharge, congestion_surcharge and airport_fee are charge components. Do not invent cbd_congestion_fee: it is absent from this 2022 file. Nonpositive amounts exist; positive-value filters must be explicit, not automatic. Recorded charges are not a verified profit measure.',
  },
  {
    id: 'tips',
    keywords: ['tip', 'tips', 'tipping', 'gratuity', 'gratuities'],
    text: 'tip_amount records credit-card tips; cash tips are not included. Zero recorded tip is not proof a passenger did not tip. total_amount also excludes cash tips. A question about actual cash tips or true tips for all trips cannot be answered: return UNANSWERABLE. Recorded average credit-card tip can use AVG(tip_amount) WHERE payment_type = 1. A tip percentage must define whether it is AVG(tip_amount/NULLIF(fare_amount,0)) or SUM(tip_amount)/NULLIF(SUM(fare_amount),0); do not silently interchange them.',
  },
  {
    id: 'passengers',
    keywords: ['passenger', 'passengers', 'people', 'person', 'single', 'occupancy'],
    text: 'passenger_count is stored as DOUBLE, despite representing a reported passenger count. Null counts occur. For percentage of known-count trips with one passenger use 100.0 * COUNT(*) FILTER (WHERE passenger_count=1) / NULLIF(COUNT(*),0) with WHERE passenger_count IS NOT NULL. Never substitute zero for unknown passengers without saying so.',
  },
  {
    id: 'locations',
    keywords: ['location', 'locations', 'zone', 'zones', 'borough', 'boroughs', 'neighborhood', 'neighbourhood', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten'],
    text: 'PULocationID and DOLocationID are numeric TLC taxi-zone identifiers. Grouping by these IDs is possible. No zone-name/borough lookup is loaded; named boroughs and neighborhoods cannot be translated to IDs from this documentation. Return UNANSWERABLE when a question requires that mapping; never guess IDs.',
  },
  {
    id: 'rate-codes',
    keywords: ['rate', 'rates', 'ratecode', 'jfk', 'newark', 'negotiated'],
    text: 'RatecodeID is a DOUBLE categorical final rate code: 1=standard, 2=JFK, 3=Newark, 4=Nassau/Westchester, 5=negotiated, 6=group ride. These are rate categories, not geographic pickup/dropoff zone identifiers. Do not translate an airport rate into a location filter.',
  },
  {
    id: 'quality',
    keywords: ['quality', 'invalid', 'missing', 'null', 'negative', 'zero', 'anomaly', 'anomalies', 'valid'],
    text: 'Verified quality caveats: missing passenger counts, zero distances, nonpositive fares, dropoffs before pickup and pickups outside the nominal month exist. These may overlap. Keep COUNT(*) distinct from COUNT(nullable_column). Describe validity filters in SQL; do not silently delete or deduplicate records. No unique trip identifier is documented. Successful SQL does not establish semantic correctness.',
  },
  {
    id: 'providers-and-flags',
    keywords: ['vendor', 'provider', 'store', 'forward', 'transmission', 'flag'],
    text: 'VendorID is a provider code; no historical provider-name mapping is established here. store_and_fwd_flag indicates whether the trip record waited in vehicle memory before transmission: Y=yes, N=no. Do not interpret this flag as trip completion or payment status.',
  },
];

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

// Score = number of distinct question tokens matching curated keywords.
// Stable id tie-break; no random choices, remote retrieval, or embeddings.
export function retrieveDocumentation(question: string): Snippet[] {
  const words = tokens(question);
  return DOCUMENTATION.map((snippet) => ({ snippet, score: snippet.keywords.filter((word) => words.has(word)).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || (a.snippet.id < b.snippet.id ? -1 : a.snippet.id > b.snippet.id ? 1 : 0))
    .slice(0, 3)
    .map(({ snippet }) => snippet);
}
