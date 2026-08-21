import { sql } from 'drizzle-orm';

/**
 * Bind a JS `Date` into a raw SQL fragment.
 *
 * Inside a `sql` template there is no column definition for the driver to infer
 * a type from, so a bare `Date` reaches the wire-protocol encoder unserialized
 * and throws `ERR_INVALID_ARG_TYPE`. Column-based helpers like `gte(col, date)`
 * are fine — this is only needed for hand-written fragments such as
 * `COUNT(*) FILTER (WHERE …)`.
 *
 * An ISO string with an explicit cast is unambiguous on every driver.
 *
 *   dsql`COUNT(*) FILTER (WHERE ${emails.sentAt} >= ${ts(since)})::int`
 */
export function ts(date: Date) {
  return sql`${date.toISOString()}::timestamptz`;
}
