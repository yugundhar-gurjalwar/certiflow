-- Runs once when the postgres volume is first created: a separate database for the automated tests,
-- so running the tests never touches demo data.
CREATE DATABASE certiflow_test;
