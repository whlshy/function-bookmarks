-- CREATE FUNCTION not_this()
CREATE OR REPLACE FUNCTION public.add_one(x integer)
RETURNS integer AS $$
BEGIN
  RETURN x + 1; -- ;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE t (id int);

CREATE VIEW active_users AS
SELECT id, CASE WHEN a THEN 1 ELSE 0 END AS flag
FROM users
WHERE note <> 'END;';

CREATE TRIGGER trg_audit
AFTER INSERT ON t
FOR EACH ROW EXECUTE FUNCTION public.add_one();
