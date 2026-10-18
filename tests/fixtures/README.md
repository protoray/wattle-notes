# Legacy SQLite index fixture

`legacy-sqlite346.bin` is a synthetic SQLite database generated with the original
bundled SQLite 3.46.0 library. It contains one invented note, an FTS5 index, one
saved revision and a harmless state marker. It contains no user data or credentials.
The fixture exercises opening an old notebook index using the patched engine,
retaining identity/metadata/history/state and continuing to search and save.

The fixture belongs to the native integration tests and source distribution;
application resource allowlists do not include it.
