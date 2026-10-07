import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  parseBacklogXml,
  parseTitleList,
  parseImport,
  splitCsvLine,
  parseRating,
  parseDate,
  detectColumns,
  IMPORT_MAX_ROWS,
} from '@/lib/import-parse';

/**
 * Import parsing is the highest-volume, least-reversible write path in the app:
 * a single import can touch hundreds of rows, and a parser that silently
 * mis-reads a column destroys work the user did elsewhere.
 *
 * These tests therefore focus on the ways a parser goes quietly wrong rather
 * than on the happy path — which is the part a dry-run preview already covers.
 */

describe('splitCsvLine', () => {
  it('splits plain fields', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  /**
   * The usual bug is a regex `split(',')`, which corrupts any field containing a
   * comma — and a review is exactly the field most likely to contain one.
   */
  it('honours quoted fields containing commas', () => {
    expect(splitCsvLine('"Hollow Knight, The",8')).toEqual(['Hollow Knight, The', '8']);
  });

  it('honours escaped double quotes', () => {
    expect(splitCsvLine('"She said ""hello""",7')).toEqual(['She said "hello"', '7']);
  });

  it('handles an escaped quote immediately before a comma', () => {
    expect(splitCsvLine('"ends with a quote""",9')).toEqual(['ends with a quote"', '9']);
  });

  it('preserves empty fields', () => {
    expect(splitCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });
});

describe('parseRating', () => {
  it('passes through a 0-10 rating', () => {
    expect(parseRating(8)).toBe(8);
    expect(parseRating('8')).toBe(8);
    expect(parseRating(10)).toBe(10);
  });

  it('treats 0 as unrated rather than invalid', () => {
    expect(parseRating(0)).toBe(0);
  });

  /**
   * Exports are wildly inconsistent. Rejecting them would make the feature
   * useless, so the convention is inferred from magnitude.
   */
  it('doubles a 1-5 rating as a star scale', () => {
    expect(parseRating(4)).toBe(8);
    expect(parseRating(5)).toBe(10);
  });

  it('converts a percentage', () => {
    expect(parseRating(85)).toBe(9);
    expect(parseRating(100)).toBe(10);
  });

  it('reads a fraction', () => {
    expect(parseRating('8/10')).toBe(8);
    expect(parseRating('4/5')).toBe(8);
    expect(parseRating('7/10')).toBe(7);
  });

  it('rejects a fraction with a zero denominator', () => {
    expect(parseRating('5/0')).toBeNull();
  });

  it('returns null for anything unusable', () => {
    expect(parseRating('')).toBeNull();
    expect(parseRating(null)).toBeNull();
    expect(parseRating(undefined)).toBeNull();
    expect(parseRating('not a number')).toBeNull();
    expect(parseRating(-3)).toBeNull();
    expect(parseRating(1000)).toBeNull();
  });
});

describe('parseDate', () => {
  it('accepts ISO', () => {
    expect(parseDate('2024-03-04')).toBe('2024-03-04');
    expect(parseDate('2024-03-04T10:22:00Z')).toBe('2024-03-04');
  });

  it('accepts slashed dates in both orders', () => {
    expect(parseDate('2024/03/04')).toBe('2024-03-04');
    expect(parseDate('04/03/2024')).toBe('2024-03-04');
  });

  /**
   * `new Date('2024-02-31')` silently rolls over to 2 March. Accepting that
   * would store a date the user never entered.
   */
  it('rejects a well-shaped but impossible date', () => {
    expect(parseDate('2024-02-31')).toBeNull();
    expect(parseDate('2024-13-01')).toBeNull();
    expect(parseDate('2024-00-10')).toBeNull();
  });

  it('accepts a written month name', () => {
    expect(parseDate('March 4, 2024')).toBe('2024-03-04');
  });

  it('returns null for junk', () => {
    expect(parseDate('sometime last year')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe('detectColumns', () => {
  it('maps a typical export header', () => {
    const { mapping } = detectColumns('Name,My Rating,Status,Date Played,Review,Hours Played');
    expect(mapping).toMatchObject({
      title: 0,
      rating: 1,
      status: 2,
      playedOn: 3,
      review: 4,
      playtimeHours: 5,
    });
  });

  it('is case- and separator-insensitive', () => {
    const { mapping } = detectColumns('GAME_TITLE,Score,State,Last_Played');
    expect(mapping.title).toBe(0);
    expect(mapping.rating).toBe(1);
    expect(mapping.status).toBe(2);
  });

  it('never maps one column to two fields', () => {
    const { mapping } = detectColumns('Name,Title');
    const values = Object.values(mapping);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('parseCsv', () => {
  it('parses a header plus rows', () => {
    const csv = [
      'Name,Rating,Status,Date Played',
      'Celeste,9,completed,2023-01-02',
      'Hollow Knight,10,completed,2022-11-30',
    ].join('\n');

    const { rows, issues } = parseCsv(csv);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      title: 'Celeste',
      rating: 9,
      status: 'completed',
      playedOn: '2023-01-02',
    });
    expect(rows[1].title).toBe('Hollow Knight');
  });

  it('treats a file with no recognisable header as a plain title column', () => {
    const { rows } = parseCsv('Celeste\nHollow Knight\nHades');
    expect(rows.map((r) => r.title)).toEqual(['Celeste', 'Hollow Knight', 'Hades']);
    expect(rows.every((r) => r.status === null)).toBe(true);
  });

  it('survives a UTF-8 BOM on the header', () => {
    const csv = '\uFEFFName,Rating\nCeleste,9';
    const { rows } = parseCsv(csv);
    expect(rows[0]?.title).toBe('Celeste');
  });

  it('normalises CRLF line endings', () => {
    const { rows } = parseCsv('Name,Rating\r\nCeleste,9\r\nHades,10');
    expect(rows).toHaveLength(2);
    expect(rows[1].title).toBe('Hades');
  });

  it('keeps a review containing a comma intact', () => {
    const csv = 'Name,Review\nCeleste,"Great game, hard ending"';
    const { rows } = parseCsv(csv);
    expect(rows[0].review).toBe('Great game, hard ending');
  });

  it('reports a row with no title rather than importing an empty game', () => {
    const csv = 'Name,Rating\nCeleste,9\n,5';
    const { rows, issues } = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(issues[0].message).toMatch(/no game title/i);
  });

  it('reports an empty file', () => {
    const { issues } = parseCsv('   \n  ');
    expect(issues[0].message).toMatch(/empty/i);
  });

  it('stops at the row ceiling and says so', () => {
    const lines = ['Name'];
    for (let i = 0; i < IMPORT_MAX_ROWS + 10; i++) lines.push(`Game ${i}`);
    const { rows, issues } = parseCsv(lines.join('\n'));
    expect(rows).toHaveLength(IMPORT_MAX_ROWS);
    expect(issues.some((i) => i.message.includes(String(IMPORT_MAX_ROWS)))).toBe(true);
  });

  it('maps every common status alias', () => {
    const csv = [
      'Name,Status',
      'A,want to play',
      'B,currently playing',
      'C,beaten',
      'D,dropped',
      'E,Played',
    ].join('\n');
    const { rows } = parseCsv(csv);
    expect(rows.map((r) => r.status)).toEqual([
      'backlog',
      'playing',
      'completed',
      'abandoned',
      'completed',
    ]);
  });
});

describe('parseBacklogXml', () => {
  const xml = `<?xml version="1.0"?>
    <backlog>
      <game>
        <name>Celeste</name>
        <rating>9</rating>
        <status>completed</status>
        <dateplayed>2023-01-02</dateplayed>
        <review>Hard but fair.</review>
      </game>
      <game>
        <name>Hades</name>
        <status>playing</status>
      </game>
    </backlog>`;

  it('parses game elements', () => {
    const { rows, issues } = parseBacklogXml(xml);
    expect(issues).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      title: 'Celeste',
      rating: 9,
      status: 'completed',
      playedOn: '2023-01-02',
      review: 'Hard but fair.',
    });
    expect(rows[1]).toMatchObject({ title: 'Hades', status: 'playing', rating: null });
  });

  it('decodes entities rather than storing them', () => {
    const one = parseBacklogXml(
      '<backlog><game><name>Portal &amp; Go</name><review>Rock &amp; roll</review></game></backlog>'
    );
    expect(one.rows[0].title).toBe('Portal & Go');
    expect(one.rows[0].review).toBe('Rock & roll');
  });

  it('decodes CDATA', () => {
    const one = parseBacklogXml(
      '<backlog><game><name>Celeste</name><review><![CDATA[Contains <b>tags</b> & symbols]]></review></game></backlog>'
    );
    expect(one.rows[0].review).toBe('Contains <b>tags</b> & symbols');
  });

  it('reports a game with no name', () => {
    const one = parseBacklogXml('<backlog><game><rating>8</rating></game></backlog>');
    expect(one.rows).toHaveLength(0);
    expect(one.issues[0].message).toMatch(/<name>/);
  });

  it('reports a file with no game elements', () => {
    const one = parseBacklogXml('<rss><channel/></rss>');
    expect(one.issues[0].message).toMatch(/Backlog/i);
  });
});

describe('parseTitleList', () => {
  it('reads one title per line', () => {
    const { rows } = parseTitleList('Celeste\nHollow Knight\nHades');
    expect(rows.map((r) => r.title)).toEqual(['Celeste', 'Hollow Knight', 'Hades']);
  });

  /**
   * Copy-pasting out of a document brings bullets and numbering along. Those
   * would otherwise become part of the game title and never match anything.
   */
  it('strips list bullets and numbering', () => {
    expect(parseTitleList('- Celeste').rows[0].title).toBe('Celeste');
    expect(parseTitleList('• Hades').rows[0].title).toBe('Hades');
    expect(parseTitleList('1. Celeste').rows[0].title).toBe('Celeste');
    expect(parseTitleList('12) Hades').rows[0].title).toBe('Hades');
  });

  it('reports no status at all, since a bare list says nothing about one', () => {
    /*
       `null`, not `backlog`.
       `commitImport` builds its update patch from every non-null field, so a
       parser that claimed `backlog` here meant re-importing the same plain list
       moved every completed log in the user's library back to backlog. The file
       expressed no opinion, so the parser must not invent one. `commitImport`
       still applies a `backlog` default for rows it is creating.
     */
    expect(parseTitleList('Celeste').rows[0].status).toBeNull();
    expect(parseTitleList('Celeste').rows[0].rating).toBeNull();
  });
});

describe('parseImport', () => {
  it('routes by extension', () => {
    expect(parseImport('games.xml', '<backlog><game><name>Celeste</name></game></backlog>').rows[0].title).toBe(
      'Celeste'
    );
    expect(parseImport('games.csv', 'Name,Rating\nCeleste,9').rows[0].title).toBe('Celeste');
    expect(parseImport('games.txt', 'Celeste\nHades').rows).toHaveLength(2);
  });

  it('sniffs the content when the extension is useless', () => {
    expect(parseImport('download', '<backlog><game><name>Celeste</name></game></backlog>').rows[0].title).toBe(
      'Celeste'
    );
    expect(parseImport('download', 'Name,Rating\nCeleste,9').rows[0].title).toBe('Celeste');
    expect(parseImport('download', 'Celeste\nHades').rows).toHaveLength(2);
  });
});