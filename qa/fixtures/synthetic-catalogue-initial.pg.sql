BEGIN;
INSERT INTO assistant_synthetic_catalogue_product(id,title,description,category,search_text) VALUES
('61000000-0000-4000-8000-000000000001','星河折叠键盘','可折叠薄型键盘。合成目录样例。','键盘','ai 键盘 便携 % _'),
('61000000-0000-4000-8000-000000000002','云桥桌面支架','家用桌面支架。合成目录样例。','桌面配件','桌面支架 可调'),
('61000000-0000-4000-8000-000000000003','旧版正弦样例','用于验证最新报价过期。','样例','旧款 过期'),
('61000000-0000-4000-8000-000000000004','失效来源样例','用于验证来源安全校验。','样例','失效 不合格'),
('61000000-0000-4000-8000-000000000005','灯塔便携支架','当前无库存的合成对照。','桌面配件','桌面支架 无库存');
WITH clock(ms) AS (SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint)
INSERT INTO assistant_synthetic_catalogue_offer(id,product_id,state,price_minor,price_scale,currency,merchant_name,merchant_url,observed_at,expires_at)
SELECT f.id,f.product,f.state,f.minor,f.scale,f.currency,'样例商家',f.url,clock.ms+f.start,clock.ms+f.expiry FROM clock CROSS JOIN (VALUES
('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','available',12990,2,'CNY','https://fixture-shop.example/products/river-keyboard',-50000,600000),
('62000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000002','available',3900,0,'JPY','https://fixture-shop.example/products/cloud-stand',-50000,600000),
('62000000-0000-4000-8000-000000000003','61000000-0000-4000-8000-000000000003','available',500,2,'USD','https://fixture-shop.example/products/old-sine',-90000,600000),
('62000000-0000-4000-8000-000000000004','61000000-0000-4000-8000-000000000003','available',599,2,'USD','https://fixture-shop.example/products/new-sine',-50000,-1000),
('62000000-0000-4000-8000-000000000005','61000000-0000-4000-8000-000000000004','available',700,2,'CNY','https://fixture-shop.example.other.example/products/not-authorized',-50000,600000),
('62000000-0000-4000-8000-000000000006','61000000-0000-4000-8000-000000000005','out_of_stock',2700,0,'JPY','https://fixture-shop.example/products/lighthouse-stand',-50000,600000)
) AS f(id,product,state,minor,scale,currency,url,start,expiry);
COMMIT;
