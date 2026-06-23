-- TechEmpower-style world table: 10,000 rows, integer PK.
drop table if exists world;
create table world (
  id          integer primary key,
  randomnumber integer not null
);
