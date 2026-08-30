\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'
SELECT format(
  'SELECT %L AS table_name, count(*)::bigint AS rows FROM %I.%I;',
  schemaname || '.' || tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY schemaname, tablename
\gexec
