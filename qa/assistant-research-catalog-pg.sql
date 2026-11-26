-- Synthetic, reference-only data for an isolated PostgreSQL research fixture.
WITH stamp AS (SELECT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT AS now_ms)
INSERT INTO assistant_retrieval_source
    (id, title, source_url, claim_text, evidence_text, search_text, accessed_at, expires_at, available)
SELECT id, title, url, claim, excerpt, search_text, now_ms - 100000, now_ms + expires_in, TRUE
FROM stamp
CROSS JOIN (VALUES
    ('ba8f4c14-4979-487a-b6af-eefd5aed2001', '合成研究来源甲', 'https://evidence.example/alpha',
     '合成陈述甲', '预先核查的甲组证据', '合成 甲 研究', 7200000),
    ('ba8f4c14-4979-487a-b6af-eefd5aed2002', '合成研究来源乙', 'https://evidence.example/beta',
     '合成陈述乙', '预先核查的乙组证据', '合成 乙 研究', 7200000),
    ('ba8f4c14-4979-487a-b6af-eefd5aed2003', '过期研究来源丙', 'https://evidence.example/stale',
     '已过期合成陈述', '已过期合成摘录', '合成 丙 研究', -1000)
) AS synthetic(id, title, url, claim, excerpt, search_text, expires_in)
ON CONFLICT (id) DO NOTHING;
