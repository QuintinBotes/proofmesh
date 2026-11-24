-- Tables, a view, a function and a procedure, and statements that name them.
CREATE TABLE customers (
  id INT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE sales.orders (
  id INT PRIMARY KEY,
  customer_id INT REFERENCES customers (id),
  total INT
);

CREATE VIEW big_orders AS
  WITH recent AS (SELECT * FROM sales.orders WHERE total > 100)
  SELECT c.name, r.total FROM recent r JOIN customers c ON c.id = r.customer_id;

CREATE FUNCTION order_total(cid INT) RETURNS INT AS $$
  SELECT sum(total) FROM sales.orders WHERE customer_id = cid
$$ LANGUAGE sql;

CREATE PROCEDURE archive_orders() LANGUAGE sql AS $$
  DELETE FROM sales.orders WHERE total = 0
$$;

INSERT INTO customers (id, name) VALUES (1, 'Ada');
UPDATE invoices SET total = order_total(1) WHERE id = 1;
