-- Fixture only: eight streams on both images, independent of runner CPU count.
-- Vary every row's input so the executable UDF cannot be constant-folded.
WITH aggregate_funnel(
    toUInt8(3), toUInt64(3600), 'first_touch', 'ordered',
    CAST(['FixtureBrowser'], 'Array(Nullable(String))'), CAST([], 'Array(Int8)'),
    CAST([
        (toFloat64(number * 4 + 1), toUUID('00000000-0000-0000-0000-000000000001'), 'FixtureBrowser', [1]),
        (toFloat64(number * 4 + 2), toUUID('00000000-0000-0000-0000-000000000002'), 'FixtureBrowser', [2]),
        (toFloat64(number * 4 + 3), toUUID('00000000-0000-0000-0000-000000000003'), 'FixtureBrowser', [3])
    ], 'Array(Tuple(Nullable(Float64), UUID, Nullable(String), Array(Int8)))')
) AS result
SELECT countIf(length(result) = 1 AND result[1].1 = 2
    AND result[1].2 = 'FixtureBrowser' AND result[1].3 = [1., 1.] AND result[1].5 = 7)
FROM numbers_mt(8192)
WHERE sleepEachRow(0.002) = 0
SETTINGS max_threads = 8, max_block_size = 64, max_execution_time = 30,
    log_queries = 1, log_queries_min_query_duration_ms = 0, log_queries_probability = 1,
    log_queries_min_type = 'QUERY_START'
FORMAT TabSeparated
