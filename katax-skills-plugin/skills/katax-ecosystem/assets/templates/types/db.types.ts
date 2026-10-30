/**
 * Row types mirroring the SQL schema 1:1 (table and column names).
 * Every db().query<T>() uses one of these (or a Pick/composite of one):
 * never `any`, never an inline `{ ... }` generic.
 * Nullable columns are `T | null` (never `?:`); dates selected with ::text are strings.
 */

/** `SELECT COUNT(*)::text AS count ...` (pg returns bigint as string). */
export interface CountRow {
  count: string;
}

/** `... RETURNING id` */
export interface IdRow {
  id: string;
}

// export interface HabitRow { id: string; user_id: string; name: string; reward: string | null; start_date: string | null; created_at: Date; updated_at: Date; }
