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

  // The bug this file's header describes: with an ordinary page set, a
  // sentence-shaped hint used to be swallowed by whichever short generic
  // title happened to appear inside it, and the append silently landed on
  // the wrong page while reporting success. These lock the boundary.
  describe('reverse containment (a title found inside a longer hint)', () => {
    const ordinaryTree: Candidate[] = [
      { id: '1', title: 'Notes' },
      { id: '2', title: 'Meeting Notes' },
    ];

    it('does NOT let a generic page swallow a sentence that merely contains its title', () => {
      // Before the specificity floor this resolved to "Notes" and the
      // paragraph was written into the wrong page with no error shown.
      const result = matchNotesByTitle(ordinaryTree, 'notes from the meeting');
      expect(result).toEqual({ status: 'no-match' });
    });

    it('does NOT resolve a general "jot this down" phrase to the catch-all page', () => {
      expect(matchNotesByTitle(ordinaryTree, 'jot this down in notes')).toEqual(
        { status: 'no-match' },
      );
    });

    it('prefers the most specific page when a shorter title nests inside it', () => {
      // "Notes" is inside "Meeting Notes", so it is present only as a
      // fragment of the better candidate — that used to read as 'ambiguous'.
      const result = matchNotesByTitle(
        ordinaryTree,
        'put this in my meeting notes page',
      );
      expect(result).toEqual({ status: 'resolved', note: ordinaryTree[1] });
    });

    it('still resolves the short "my <title> page" wrapper the Coach actually emits', () => {
      const notes: Candidate[] = [{ id: '1', title: 'Ideas' }];
      expect(matchNotesByTitle(notes, 'my ideas page')).toEqual({
        status: 'resolved',
        note: notes[0],
      });
    });

    it('stays ambiguous when two unrelated titles both sit inside a short hint', () => {
      const notes: Candidate[] = [
        { id: '1', title: 'Ideas' },
        { id: '2', title: 'Books' },
      ];
      // Both clear the specificity floor here, and neither nests inside the
      // other, so there is a genuine choice to make and we refuse to make it.
      const result = matchNotesByTitle(notes, 'ideas and books');
      expect(result.status).toBe('ambiguous');
      if (result.status === 'ambiguous') {
        expect(result.candidates.map((c) => c.id).sort()).toEqual(['1', '2']);
      }
    });

    it('is no-match, not ambiguous, once the hint outgrows every candidate', () => {
      const notes: Candidate[] = [
        { id: '1', title: 'Ideas' },
        { id: '2', title: 'Books' },
      ];
      expect(matchNotesByTitle(notes, 'my ideas and books')).toEqual({
        status: 'no-match',
      });
    });
  });

  describe('punctuation folding', () => {
    it('matches a title whose apostrophe the user did not type', () => {
      const notes: Candidate[] = [{ id: '1', title: "Qur'an Notes" }];
      expect(matchNotesByTitle(notes, 'quran notes')).toEqual({
        status: 'resolved',
        note: notes[0],
      });
    });

    it('matches across the typographic apostrophe iOS substitutes automatically', () => {
      const notes: Candidate[] = [{ id: '1', title: 'Daily Du’as' }];
      expect(matchNotesByTitle(notes, 'daily duas')).toEqual({
        status: 'resolved',
        note: notes[0],
      });
    });

    it('treats a dash between words as a space rather than deleting it', () => {
      const notes: Candidate[] = [{ id: '1', title: 'Q1-Review' }];
      expect(matchNotesByTitle(notes, 'q1 review')).toEqual({
        status: 'resolved',
        note: notes[0],
      });
      // ...and specifically NOT as if the words had been run together.
      expect(matchNotesByTitle(notes, 'q1review')).toEqual({
        status: 'no-match',
      });
    });

    it('does not let punctuation folding collapse two distinct pages into one', () => {
      const notes: Candidate[] = [
        { id: '1', title: 'Q1-Review' },
        { id: '2', title: 'Q1 Review' },
      ];
      const result = matchNotesByTitle(notes, 'Q1 Review');
      expect(result.status).toBe('ambiguous');
    });
  });

  describe('tier ordering', () => {
    it('prefers a real partial title over a sentence containing a generic one', () => {
      const notes: Candidate[] = [
        { id: '1', title: 'Notes' },
        { id: '2', title: 'Research Papers' },
      ];
      // "research papers" is contained IN the title of note 2 (forward tier),
      // which must win outright rather than tying with "Notes".
      expect(matchNotesByTitle(notes, 'research papers')).toEqual({
        status: 'resolved',
        note: notes[1],
      });
    });
  });
});
