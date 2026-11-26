INSERT INTO assistant_retrieval_source
    (id, title, source_url, claim_text, evidence_text, search_text, accessed_at, expires_at, available)
VALUES
    ('364c9c66-3f0b-4dc0-82a2-3649ed7ab501', '合成手册甲', 'https://example.com/qa/retrieval/a',
     '虚构样本甲的校验号为 720。', '样本甲：校验号 720。', '合成校验 thyme720', 1704067200000, 4102444800000, TRUE),
    ('364c9c66-3f0b-4dc0-82a2-3649ed7ab502', '合成手册乙', 'https://example.com/qa/retrieval/b',
     '虚构样本乙的校验号为 721。', '样本乙：校验号 721。', '合成校验 thyme720', 1704067200000, 4102444800000, TRUE),
    ('364c9c66-3f0b-4dc0-82a2-3649ed7ab503', '合成检索浏览器手册', 'https://example.com/qa/retrieval/browser',
     '虚构浏览器样本的校验号为 722。', '浏览器样本：校验号 722。', 'browsercheck722 合成浏览器核对', 1704067200000, 4102444800000, TRUE);
