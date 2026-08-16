import {
  appendNoteParagraph,
  escapeNoteHtml,
  matchNotesByTitle,
  normalizeNoteContent,
} from './note-content';

describe('normalizeNoteContent', () => {
  it('treats the legacy JSON-blocks default as an empty document', () => {
    expect(normalizeNoteContent('[]')).toBe('');
  });

  it('treats whitespace-only content as empty', () => {
    expect(normalizeNoteContent('   ')).toBe('');
  });

  it('leaves real HTML content untouched', () => {
    expect(normalizeNoteContent('<p>Hello</p>')).toBe('<p>Hello</p>');
  });
});

describe('escapeNoteHtml', () => {
  it('escapes every character that could otherwise be read as markup', () => {
    expect(escapeNoteHtml(`<script>alert("hi")</script> & 'quote'`)).toBe(
      '&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; &amp; &#39;quote&#39;',
    );
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeNoteHtml('read about dynamo')).toBe('read about dynamo');
  });
});

describe('appendNoteParagraph', () => {
  it('appends the addition as its own escaped paragraph', () => {
    expect(appendNoteParagraph('<p>Existing</p>', 'milk & eggs')).toBe(
      '<p>Existing</p><p>milk &amp; eggs</p>',
    );
  });

  it('starts from an empty document when the note was blank ("[]")', () => {
    expect(appendNoteParagraph('[]', 'milk')).toBe('<p>milk</p>');
  });

  it('never lets appended markup break out of its own paragraph', () => {
    const result = appendNoteParagraph(
      '<p>Existing</p>',
      '<b>urgent</b> call back',
    );
    expect(result).toBe(
      '<p>Existing</p><p>&lt;b&gt;urgent&lt;/b&gt; call back</p>',
    );
    expect(result).not.toContain('<b>urgent</b>');
  });
});

interface Candidate {
  id: string;
  title: string;
}

describe('matchNotesByTitle', () => {
  it('resolves a single case-insensitive, whitespace-normalized exact match', () => {
    const notes: Candidate[] = [
      { id: '1', title: 'Research Papers' },
      { id: '2', title: 'Groceries' },
    ];
    const result = matchNotesByTitle(notes, '  research   papers ');
    expect(result).toEqual({ status: 'resolved', note: notes[0] });
  });

  it('prefers an exact match over a substring match that also exists', () => {
    const notes: Candidate[] = [
      { id: '1', title: 'Research Papers' },
      { id: '2', title: 'Research Papers - Archive' },
    ];
    const result = matchNotesByTitle(notes, 'Research Papers');
    expect(result).toEqual({ status: 'resolved', note: notes[0] });
  });

  it('falls back to a substring match when there is no exact match', () => {
    const notes: Candidate[] = [
      { id: '1', title: 'Research Papers' },
      { id: '2', title: 'Groceries' },
    ];
    const result = matchNotesByTitle(notes, 'papers');
    expect(result).toEqual({ status: 'resolved', note: notes[0] });
  });

  it('matches when the note title is a substring of a longer hint', () => {
    const notes: Candidate[] = [{ id: '1', title: 'Ideas' }];
    const result = matchNotesByTitle(notes, 'my ideas page');
    expect(result).toEqual({ status: 'resolved', note: notes[0] });
  });

  it('is ambiguous when the exact tier has more than one hit', () => {
    const notes: Candidate[] = [
      { id: '1', title: 'Notes' },
      { id: '2', title: 'notes' },
    ];
    const result = matchNotesByTitle(notes, 'Notes');
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('is ambiguous when the substring tier has more than one hit', () => {
    const notes: Candidate[] = [
      { id: '1', title: 'Research Papers - Q1' },
      { id: '2', title: 'Research Papers - Q2' },
    ];
    const result = matchNotesByTitle(notes, 'research papers');
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates.map((c) => c.id).sort()).toEqual(['1', '2']);
    }
  });

  it('is no-match when nothing qualifies at any tier', () => {
    const notes: Candidate[] = [{ id: '1', title: 'Groceries' }];
    expect(matchNotesByTitle(notes, 'research papers')).toEqual({
      status: 'no-match',
    });
  });

  it('is no-match against an empty note list', () => {
    expect(matchNotesByTitle([], 'anything')).toEqual({ status: 'no-match' });
  });

  it('is no-match for a blank or whitespace-only hint, never a wildcard', () => {
    const notes: Candidate[] = [{ id: '1', title: 'Groceries' }];
    expect(matchNotesByTitle(notes, '   ')).toEqual({ status: 'no-match' });
  });

  it('never lets a blank-titled note match every hint via the substring tier', () => {
    const notes: Candidate[] = [
      { id: '1', title: '' },
      { id: '2', title: 'Groceries' },
    ];
    const result = matchNotesByTitle(notes, 'anything at all');
    expect(result).toEqual({ status: 'no-match' });
  });
});
