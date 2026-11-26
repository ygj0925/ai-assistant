BEGIN;
WITH clock(ms) AS (SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint)
INSERT INTO assistant_synthetic_catalogue_offer(id,product_id,state,price_minor,price_scale,currency,merchant_name,merchant_url,observed_at,expires_at)
SELECT '62000000-0000-4000-8000-000000000007','61000000-0000-4000-8000-000000000001','available',10950,2,'CNY','样例商家',
    'https://fixture-shop.example/products/river-keyboard',ms-10,ms+600000 FROM clock;
INSERT INTO assistant_synthetic_catalogue_offer(id,product_id,state,observed_at)
VALUES ('62000000-0000-4000-8000-000000000008','61000000-0000-4000-8000-000000000002','delisted',(extract(epoch FROM clock_timestamp())*1000)::bigint-10);
COMMIT;
SELECT json_build_object(
    'productRows',(SELECT COUNT(*) FROM assistant_synthetic_catalogue_product),
    'observations',(SELECT COUNT(*) FROM assistant_synthetic_catalogue_offer),
    'originalPriceRows',(SELECT COUNT(*) FROM assistant_synthetic_catalogue_offer WHERE price_minor=12990),
    'newPriceRows',(SELECT COUNT(*) FROM assistant_synthetic_catalogue_offer WHERE price_minor=10950),
    'delistedLatestRows',(SELECT COUNT(*) FROM assistant_synthetic_catalogue_offer WHERE state='delisted'),
    'migrations',(SELECT COUNT(*) FROM databasechangelog WHERE id LIKE 'assistant-synthetic-catalogue-%')
);
