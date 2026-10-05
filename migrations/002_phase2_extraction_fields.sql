ALTER TABLE contracts ADD COLUMN is_abstract INTEGER;
ALTER TABLE contracts ADD COLUMN source TEXT;
ALTER TABLE state_variables ADD COLUMN mutability TEXT;
