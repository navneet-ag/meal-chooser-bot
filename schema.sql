CREATE TABLE roster (
  chat_id INTEGER PRIMARY KEY,
  names_json TEXT,
  default_n INTEGER
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,
  session_index INTEGER,
  n INTEGER,
  started_at TEXT,
  status TEXT
);

CREATE TABLE participants (
  session_id INTEGER,
  name TEXT,
  quota INTEGER,
  remaining INTEGER,
  PRIMARY KEY (session_id, name),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE meal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  meal_number INTEGER,
  name TEXT,
  method TEXT,
  probability REAL,
  forced INTEGER,
  logged_at TEXT,
  update_id INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE food_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,
  dish TEXT,
  logged_at TEXT,
  update_id INTEGER
);

CREATE TABLE menu_items (
  chat_id INTEGER,
  name TEXT,
  added_at TEXT,
  PRIMARY KEY (chat_id, name)
);

CREATE TABLE processed_updates (
  chat_id INTEGER,
  update_id INTEGER,
  PRIMARY KEY (chat_id, update_id)
);
