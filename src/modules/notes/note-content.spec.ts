import {
  appendNoteParagraph,
  escapeNoteHtml,
  matchNotesByTitle,
  normalizeNoteContent,
  noteHtmlToStructuredText,
  sanitizeSummaryHtml,
  stripDanglingNoteReference,
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

describe('stripDanglingNoteReference', () => {
  it('trims the exact reported case: content that dangles on a bare "to my"', () => {
    expect(
      stripDanglingNoteReference('computer science , learning to my'),
    ).toBe('computer science , learning');
  });

  it('trims a bare dangling "for my" / "in my" / "on my" / "into my" / "onto my"', () => {
    expect(stripDanglingNoteReference('buy milk for my')).toBe('buy milk');
    expect(stripDanglingNoteReference('left a reminder in my')).toBe(
      'left a reminder',
    );
    expect(stripDanglingNoteReference('jot this down on my')).toBe(
      'jot this down',
    );
    expect(stripDanglingNoteReference('filed the receipt into my')).toBe(
      'filed the receipt',
    );
    expect(stripDanglingNoteReference('add this onto my')).toBe('add this');
  });

  it('trims a dangling preposition + possessive followed by a bare generic note word', () => {
    expect(stripDanglingNoteReference('buy milk to my notes')).toBe(
      'buy milk',
    );
    expect(stripDanglingNoteReference('buy milk to my note')).toBe(
      'buy milk',
    );
    expect(stripDanglingNoteReference('buy milk to my page')).toBe(
      'buy milk',
    );
    expect(stripDanglingNoteReference('buy milk to my notebook')).toBe(
      'buy milk',
    );
  });

  it('trims a dangling "our" form the same way as "my"', () => {
    expect(stripDanglingNoteReference('add this to our')).toBe('add this');
  });

  it('trims a comma directly preceding the dangling phrase', () => {
    expect(stripDanglingNoteReference('buy milk, to my')).toBe('buy milk');
  });

  it('is case-insensitive', () => {
    expect(stripDanglingNoteReference('buy milk TO MY')).toBe('buy milk');
  });

  it('leaves ordinary content that legitimately ends in a phrasal verb alone', () => {
    // A bare trailing preposition with no possessive after it is a normal,
    // complete English sentence — never touched.
    expect(stripDanglingNoteReference('left the porch light on')).toBe(
      'left the porch light on',
    );
    expect(stripDanglingNoteReference('turn the timer off')).toBe(
      'turn the timer off',
    );
    expect(stripDanglingNoteReference('the door was left open')).toBe(
      'the door was left open',
    );
  });

  it('leaves content alone when "to"/"in"/"on" is part of a longer word, not a standalone preposition', () => {
    expect(stripDanglingNoteReference('study of ancient Latin my')).toBe(
      'study of ancient Latin my',
    );
    expect(stripDanglingNoteReference('upload the photo my')).toBe(
      'upload the photo my',
    );
  });

  it('leaves content alone when "my"/"our" is followed by a real noun other than a generic note word', () => {
    // "my" + a specific, non-generic noun is a complete, meaningful phrase —
    // stripping it would delete real content, so it is never touched.
    expect(stripDanglingNoteReference('grateful for my family')).toBe(
      'grateful for my family',
    );
    expect(stripDanglingNoteReference('proud of what we built for our team')).toBe(
      'proud of what we built for our team',
    );
  });

  it('leaves content alone when the preposition + possessive is not at the very end', () => {
    expect(
      stripDanglingNoteReference('went back to my desk and kept working'),
    ).toBe('went back to my desk and kept working');
  });

  it('returns the content unchanged when there is nothing dangling', () => {
    expect(stripDanglingNoteReference('finished the report early today')).toBe(
      'finished the report early today',
    );
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

describe('noteHtmlToStructuredText', () => {
  it('keeps block boundaries as newlines rather than collapsing to one line', () => {
    // The whole reason this is not a copy of the mobile one-line preview
    // helper: paragraph boundaries are the summarizer's strongest signal for
    // where one topic ends and the next begins.
    expect(
      noteHtmlToStructuredText('<p>First point</p><p>Second point</p>'),
    ).toBe('First point\nSecond point');
  });

  it('renders headings with their outline depth', () => {
    expect(
      noteHtmlToStructuredText('<h1>Lecture</h1><h2>Part one</h2><p>Body</p>'),
    ).toBe('# Lecture\n## Part one\nBody');
  });

  it('renders list items as bullets', () => {
    expect(
      noteHtmlToStructuredText('<ul><li>Alpha</li><li>Beta</li></ul>'),
    ).toBe('- Alpha\n- Beta');
  });

  it('keeps table cells on one line, separated', () => {
    // Web-authored notes really can contain tables, so this is a live path.
    expect(
      noteHtmlToStructuredText(
        '<table><tr><td>Term</td><td>Meaning</td></tr></table>',
      ),
    ).toBe('Term Meaning');
  });

  it('decodes entities so the model sees the characters the user typed', () => {
    expect(noteHtmlToStructuredText('<p>Tom &amp; Jerry &lt;3</p>')).toBe(
      'Tom & Jerry <3',
    );
  });

  it('drops script and style bodies instead of feeding them to the model', () => {
    expect(
      noteHtmlToStructuredText(
        '<p>Real</p><script>alert(1)</script><style>p{color:red}</style>',
      ),
    ).toBe('Real');
  });

  it('treats the legacy empty placeholder as an empty document', () => {
    expect(noteHtmlToStructuredText('[]')).toBe('');
  });

  it('drops the empty paragraphs dictation leaves behind', () => {
    // One line per block, not one line per tag — otherwise a long dictated
    // note spends a real slice of the context window on whitespace.
    expect(
      noteHtmlToStructuredText('<p>A</p><p></p><p></p><p></p><p>B</p>'),
    ).toBe('A\nB');
  });
});

describe('sanitizeSummaryHtml', () => {
  /** Convenience: assert acceptance and return the normalized markup. */
  const accept = (html: string): string => {
    const result = sanitizeSummaryHtml(html);
    if (result.status !== 'ok') {
      throw new Error(`expected acceptance, got rejected: ${result.reason}`);
    }
    return result.html;
  };

  const reject = (html: string): string => {
    const result = sanitizeSummaryHtml(html);
    if (result.status !== 'rejected') {
      throw new Error(`expected rejection, got: ${result.html}`);
    }
    return result.reason;
  };

  it('passes through the full allowed vocabulary unchanged', () => {
    const html =
      '<h1>Title</h1><h2>Section</h2><h3>Sub</h3><p>Body with ' +
      '<strong>bold</strong>, <em>italic</em>, <u>under</u>, <s>struck</s>, ' +
      '<code>inline</code> and <mark>highlight</mark>.</p>' +
      '<ul><li>Bullet</li></ul><ol><li>Numbered</li></ol>' +
      '<blockquote><p>Quoted</p></blockquote>';
    expect(accept(html)).toBe(html);
  });

  it('keeps TipTap task lists, which both editors can parse', () => {
    const html =
      '<ul data-type="taskList">' +
      '<li data-type="taskItem" data-checked="true"><p>Done</p></li>' +
      '<li data-type="taskItem" data-checked="false"><p>Todo</p></li>' +
      '</ul>';
    expect(accept(html)).toBe(html);
  });

  it('keeps safe links and drops the anchor (not the words) on an unsafe one', () => {
    expect(accept('<p><a href="https://x.test/a">docs</a></p>')).toBe(
      '<p><a href="https://x.test/a">docs</a></p>',
    );
    expect(accept('<p><a href="javascript:alert(1)">click</a></p>')).toBe(
      '<p>click</p>',
    );
    expect(accept('<p><a href="data:text/html,x">click</a></p>')).toBe(
      '<p>click</p>',
    );
  });

  it('normalizes synonym tags rather than failing a whole call over them', () => {
    expect(accept('<p><b>bold</b> and <i>italic</i></p>')).toBe(
      '<p><strong>bold</strong> and <em>italic</em></p>',
    );
  });

  it('flattens h4-h6 to h3, because the editors have no node past level 3', () => {
    // A deleted heading is worse than a flattened one — ProseMirror would
    // discard a level it has no schema entry for.
    expect(accept('<h4>Deep</h4>')).toBe('<h3>Deep</h3>');
  });

  it('unwraps meaningless containers, keeping their children', () => {
    expect(accept('<div><p>Kept</p></div>')).toBe('<p>Kept</p>');
    expect(accept('<div><section><p>Kept</p></section></div>')).toBe(
      '<p>Kept</p>',
    );
  });

  it('strips every attribute the editors do not read', () => {
    expect(
      accept(
        '<p class="lead" style="text-align: center" data-indent="2">X</p>',
      ),
    ).toBe('<p>X</p>');
  });

  it('drops script and style along with their contents', () => {
    expect(accept('<p>Safe</p><script>alert(1)</script>')).toBe('<p>Safe</p>');
    expect(accept('<p>Safe</p><style>p{color:red}</style>')).toBe(
      '<p>Safe</p>',
    );
  });

  it('escapes a bare ampersand but leaves a real entity alone', () => {
    expect(accept('<p>Tom & Jerry &mdash; also &amp; fine</p>')).toBe(
      '<p>Tom &amp; Jerry &mdash; also &amp; fine</p>',
    );
  });

  it('is not fooled by a > inside an attribute value', () => {
    expect(accept('<p><a href="https://x.test/?a=1>2">link</a></p>')).toBe(
      '<p><a href="https://x.test/?a=1&gt;2">link</a></p>',
    );
  });

  // ---- rejection: structure, not decoration ----

  it('rejects an unclosed element, because that means a truncated response', () => {
    // The single most important case. A provider that stops at its output cap
    // ends mid-document; auto-closing would persist half a summary that looks
    // complete under a title claiming to cover the whole lecture.
    expect(reject('<h1>Summary</h1><p>It started well')).toMatch(/cut short/);
  });

  it('rejects a tag cut off mid-way', () => {
    expect(reject('<p>Fine</p><p>Next</p><stro')).toMatch(/cut short/);
  });

  it('rejects mismatched nesting', () => {
    expect(reject('<p><strong>x</p></strong>')).toMatch(/does not match/);
  });

  it('rejects markup with no text at all', () => {
    expect(reject('<p></p><p>   </p>')).toMatch(/no text/);
    expect(reject('')).toMatch(/no text/);
  });

  it('rejects elements it cannot degrade safely', () => {
    expect(reject('<table><tr><td>a</td></tr></table>')).toMatch(
      /<table> is not allowed/,
    );
    expect(reject('<pre><code>x</code></pre>')).toMatch(/<pre> is not allowed/);
    expect(reject('<p>a</p><iframe src="https://x.test"></iframe>')).toMatch(
      /<iframe> is not allowed/,
    );
  });

  // ---- the invariant that keeps a generated summary editable on the phone ----

  it('can never emit markup that would lock the note on mobile', () => {
    // goalslot-mobile's `hasUnsupportedMobileMarkup` makes a note READ-ONLY on
    // the phone when it sees a table, an <hr>, a <pre>, a text-align style or a
    // data-indent. A summary carrying any of those would be born un-editable on
    // the device the user is holding — the exact opposite of what they asked
    // for. The five patterns below are that guard's list, kept in step by hand
    // (the guard itself lives in the mobile repo and cannot be imported here).
    const mobileFormatLockPatterns = [
      /<table[\s/>]/i,
      /<hr[\s/>]/i,
      /<pre[\s/>]/i,
      /style="[^"]*text-align/i,
      /\sdata-indent="/i,
    ];

    // Everything the sanitizer is willing to ACCEPT, including the inputs most
    // likely to smuggle one of those through.
    const accepted = [
      accept('<h1>T</h1><h2>S</h2><p><strong>b</strong> <em>i</em></p>'),
      accept('<p style="text-align: center" data-indent="3">Centered</p>'),
      accept('<div><p>Wrapped</p></div>'),
      accept(
        '<ul data-type="taskList"><li data-type="taskItem" ' +
          'data-checked="false"><p>Task</p></li></ul>',
      ),
      accept('<p><a href="https://x.test">link</a></p>'),
      accept('<blockquote><p>Source: Lecture, 16 Aug</p></blockquote>'),
      accept('<p>&lt;hr&gt; and &lt;table&gt; written as text</p>'),
    ];

    for (const html of accepted) {
      for (const pattern of mobileFormatLockPatterns) {
        expect(pattern.test(html)).toBe(false);
      }
    }
  });
});
