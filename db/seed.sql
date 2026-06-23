-- Seed 10,000 rows with random values, then warm the cache.
insert into world (id, randomnumber)
select g, 1 + floor(random() * 10000)::int
from generate_series(1, 10000) as g;

-- sanity
select count(*) as rows, min(id) as min_id, max(id) as max_id from world;
