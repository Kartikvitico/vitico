-- Optional: sample products so the catalogue is not empty while you test.
-- Delete them later from Admin > Products, or replace them with your own list using the import box.
insert into public.products (sku, name, pack, category, base_price, fccc_ref, cbm, kg, stock, promo_pct) values
 ('RIC','Long grain rice','Bale of 4 × 10 kg','Staples',98,104,0.055,41,1200,0),
 ('FLR','Normal flour','Bale of 4 × 10 kg','Staples',62,66.4,0.05,41,900,0),
 ('SUG','White sugar','Carton of 10 × 2 kg','Staples',44.5,47,0.028,20.5,1500,0),
 ('OIL','Soya bean oil','Carton of 6 × 2 L','Staples',71,76.2,0.022,12,640,0),
 ('TUN','Canned tuna flakes','Carton of 48 × 170 g','Canned',118,126,0.018,10.5,820,0),
 ('MAC','Canned mackerel','Carton of 24 × 425 g','Canned',86,91.2,0.02,12.6,560,0),
 ('CRN','Corned beef','Carton of 24 × 340 g','Canned',168,null,0.016,9.4,700,0),
 ('NDL','Instant noodles','Carton of 30 × 85 g','Snacks',27.5,null,0.03,3,2400,5),
 ('BIS','Breakfast crackers','Carton of 24 × 375 g','Snacks',58,null,0.045,10,480,0),
 ('MLK','UHT full cream milk','Carton of 12 × 1 L','Drinks',39,null,0.017,13,1100,0),
 ('WTR','Bottled water','Carton of 24 × 600 ml','Drinks',16.8,null,0.022,15.2,3000,0),
 ('TEA','Tea bags','Carton of 24 × 100 bags','Drinks',132,null,0.04,6.5,300,0),
 ('SOP','Laundry soap bars','Carton of 48','Household',54,null,0.024,15,750,0),
 ('TIS','Toilet tissue','Bale of 6 × 10 rolls','Household',49,null,0.09,6,620,0)
on conflict (sku) do nothing;
