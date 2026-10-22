# Resume transform: precision and speed report

Updated 22 October 2026. Work in progress: the final check on new pairs has not run yet.

## Short answer

- **What shipped makes results more reliable, not yet more precise or faster.** On the 33 held-back pairs, no draft was rejected (before: 4 first tries). Degrees and certificates are no longer left out of the fit report's evidence.
- **A faster, more targeted writer was built but not shipped.** It cut the median time from 91 s to 60 s and nearly removed irrelevant edits. But AI reviewers rated its writing lower, flagged an invented detail in 3 of 33 results (the version before the safe fixes: 1) and found its fit report less accurate. That failed the rules set before testing.
- **ship3 is being tested.** It adds an AI fact-check of every edit, so each result is checked for invented details (part of your "check each result" ask; precision to the job is still measured only in testing). It also has stricter writing rules and a fuller fit report. On the 77 dev pairs it listed as many requirements as the live version, at a median of 75 s (before the safe fixes 87 s, targeted 60 s). But the fact-check made it cautious: it used the job's wording less often, and 6 of 76 results ended with no real edits. Its combined first AI call also ran past the hosted site's 60-second limit in 17 of 77 results, which must be fixed before it can ship. It has no reviewer scores yet.
- **What I need from you: nothing now.** When the final check on 32 new student-focused pairs is done, I will ask whether to ship ship3. If it fails, today's version stays as it is and I will report which rule failed.

## 1. What you asked for

Make the transform more precise to the job description, and faster if possible. Test it on at least 100 real job descriptions and real resumes, and check after each transform that the result is precise.

## 2. How it was tested

### Test data

- **110 real resume and job-post pairs.** 77 were used during development. 33 were **held back**: kept aside and used only to check a finished change.
- **32 new pairs for the final check**, collected on 22 October and not yet used: 26 realistic applications, 4 stretches and 2 mismatches. 29 of the 32 resumes belong to students, new graduates or early-career people, and the posts span 22 fields and four levels: 9 internship, 13 entry, 6 junior and 4 associate. The resumes come from the same two datasets as below (23 and 9), with three third parties' names removed. The posts come from the same kinds of public job boards plus NYC Open Data (Greenhouse 16, Ashby 8, Lever 4, SmartRecruiters 2, Workday 1, NYC Open Data 1), fetched on 22 October.
- **Resumes**: 120 from two public datasets published for sharing or research, both already anonymised by their publishers: [opensporks/resumes](https://huggingface.co/datasets/opensporks/resumes) (92; CC0-1.0 on its dataset card) and [lang-uk/recruitment-dataset-candidate-profiles-english](https://huggingface.co/datasets/lang-uk/recruitment-dataset-candidate-profiles-english) (28; MIT on its dataset card, Apache-2.0 in the upstream repository). Each was converted to Landwise's text format and given a placeholder name and contact line. Details the publishers' anonymisation had missed were removed from 11 resumes: a name in one summary; citations, a thesis title or a patent number that could identify the author (6 resumes, counting the one with the name); licence numbers (2); a third party's surname (1); and an employer's street address and a college's ZIP code (2).
- **Job posts**: 119 public postings, live when fetched on 21 October 2026, without login and at low request rates. 116 came from employers' job boards and career pages (Greenhouse 67, Ashby 15, Lever 14, SmartRecruiters 12, Workday 5, UKG Pro 2, Oracle 1) and 3 from the NYC Open Data jobs dataset. The 110 paired posts cover 23 fields and five levels: 18 internship, 43 entry, 28 junior, 15 associate and 6 mid-level.
- **Fit**: 83 of the 110 pairs are realistic applications. 16 are stretches and 11 are deliberate mismatches, to check that gaps are reported honestly and nothing is invented.
- The test data and the recorded AI replies stay private, outside this repository. The postings belong to their employers and the resumes stay under their datasets' licences. Both are used only for private evaluation.

### How each version was run

Every version ran the real Landwise code through the local version's ChatGPT sign-in, with the hosted site's model settings: gpt-6-luna, low reasoning effort and JSON output. The one exception is the local-model comparison in section 6. Every AI reply was recorded, so changes to code alone could be re-scored offline. Times were measured through ChatGPT, and the hosted site's 60-second limit per AI call was not applied. On the held-back pairs it would have affected 1 of 33 results in the live and safe runs and none in the targeted writer's. On the dev pairs it would have affected 5 of 77 live results, none of the targeted writer's and 17 of ship3's (section 5).

### What was measured

- **Automatic, on every result**: delivered or rejected; number of edits; share of edits on bullets related to a job requirement; job keywords that an edit removed; time per step; size of the largest request.
- **AI reviewers**: Claude reviewers, one per pair, each grading 4 to 6 pairs with a fixed rubric. Each saw the job post, the original resume and two results in random order, without knowing which version made which. Scores from 1 to 5: job alignment, faithfulness to the original, fit-report accuracy, missed opportunities (higher means fewer missed) and writing quality. Flags: invented detail, wrong gap, irrelevant edit and harmful edit. There was no second reviewer and no tie-break, so each flag rests on one reviewer's judgement. The plan also called for a second reviewer on every invented-detail flag; that has not been done yet.
- **Intervals**: each reviewer-score difference comes with a 95% interval from a paired bootstrap, computed exactly. If the whole interval is above or below zero, the change is unlikely to be chance ("clear" below). With about 33 pairs the intervals are wide, so "not clear" does not mean "no change".

### Ship rules, set before testing

These are the main rules, simplified. A new version replaces the live one only if, on pairs not used while building it:

- results with an invented detail rise by at most 1 percentage point, and no edit changes a number;
- failed results rise by at most 2 percentage points (any product failure: a rejected draft, an unreadable or incomplete AI reply, a result over its page limit or a hosted time-out);
- precision clearly improves: reviewers' job alignment rises by at least 0.3 with an interval above zero (two automatic measures can also qualify), while faithfulness and fit-report accuracy each fall by at most 0.1 and wrong gaps rise by at most 2 percentage points;
- the median time grows by at most 10%, and the cost per result by at most 50%, within the hosted per-job limit;
- the 35% edit cap holds, non-bullet lines stay untouched and evidence quotes stay verbatim.

With about 33 pairs, one result is 3 percentage points. So the invented-detail, rejected-result and wrong-gap rules allow no increase at all.

## 3. Shipped: safe fixes (`a6bc035`)

These were shipped as bug fixes. They do not change the prompts. They were judged on automatic checks only and were not reviewed by the AI reviewers.

| 33 held-back pairs | Before | After |
|---|---|---|
| Rejected drafts (first tries) | 4 | 0 |
| Listed degree called a gap (hand-checked) | 3 | 1 |
| Edits per result (average) | 10.4 | 10.4 |
| Median time | 90.6 s | 90.8 s |

Both columns are separate live runs; the edit counts happen to round to the same value.

What changed:

- **Each edit is checked on its own.** An edit that breaks a rule is removed with a reason code, and the rest of the draft is kept. Rules include changing a number written in digits, adding an unsupported keyword, growing too long and removing contact details. Before, one such edit failed the whole draft. On the held-back pairs, 4 first tries were rejected: 3 worked on a retry and 1 failed twice. Replaying that one, and all 7 rejected dev results, through the new checks delivered them. Network time-outs are not counted.
- **Two stricter keyword rules are new.** A job's named tool or credential can no longer be added on related-only evidence, and a keyword of a directly supported requirement can be added only to the bullet that proves it. Edits that return their bullet unchanged are no longer counted.
- **Degrees and certificates stay in the fit report's evidence.** The AI labels them "qualification", which an old type check rejected. That left 2.7% of extracted resume facts (dev pairs) and 5.0% (held-back pairs) out of the evidence, so the fit report could call a listed degree a gap. The resume text itself was never affected. The writer now also sees these facts.
- **Whole-word matching.** "Java" no longer matches "JavaScript", and "SQL" no longer matches "NoSQL".
- **Fit report.** An edited bullet that still states the quoted fact keeps counting as evidence; before, any rewording of the quoted words dropped it. An edit that deletes the fact never counts. "Edits made" lists only edits that were kept. When the AI gives no next step, the default advice now depends on the type of requirement.
- **Local use** sends JSON-mode requests, like the hosted site.

Not fixed yet: the number check reads only digits, so a spelled-out number ("three") can change unnoticed. This applies to the live version too (see section 4).

## 4. Built, not shipped: the targeted writer

In sections 4 to 6, "live version" means the version before the safe fixes. The targeted writer and ship3 are built on the safe fixes, so these comparisons include them. The safe fixes do not change the prompt templates, so the live version's edit scores (job alignment, faithfulness, writing) should still describe today's site closely. Its fit-report numbers and delivery do not: 3 of its 6 wrong-gap results were listed degrees that the shipped fix now reports correctly, and with the safe fixes it delivers all 77 dev results.

**How it works.** Code picks "edit targets" first: the job's requirements that the resume can back up, most important first, each pointing to the bullet that proves it. The AI is told to edit those bullets, and to use the job's wording only where the bullet supports it. Code does not enforce the first part, but in the tests every edit did land on a target. The writing prompt is about 40% shorter. It gets the ranked targets and at most 12 requirements with short match notes, instead of the full fact list, the full job analysis and a block of retrieved resume snippets.

**Automatic results, 33 held-back pairs**

| | Live | Targeted |
|---|---|---|
| Edits per result (average) | 10.4 | 3.5 |
| Edits on a requirement's bullet | 57% | 100% |
| Job keywords removed per result | 0.66 | 0.12 |
| Median time | 90.6 s | 60.0 s |

Fewer edits is intended, though reviewers often noted unused edit slots. The 100% is by design: the targets are chosen with the same matching that the measure uses. Scored with the live version's matching instead, 88% of targeted edits land on a requirement's bullet, against 57% of live edits. On the 77 dev pairs the picture is the same: 61% against 100% of edits on a requirement's bullet, median time 86.6 s against 60.2 s, and the largest request 36,200 against 22,300 characters on average.

**AI review, 33 held-back pairs** (scores 1 to 5)

| Measure | Live → Targeted | Change [95% interval] |
|---|---|---|
| Job alignment | 1.91 → 2.27 | +0.36 [0.03, 0.73] clear, just |
| Missed opportunities | 2.48 → 2.73 | +0.24 [0.09, 0.42] clear |
| Faithfulness | 4.58 → 4.39 | −0.18 [−0.52, 0.12] |
| Fit-report accuracy | 3.25 → 2.94 | −0.31 [−0.72, 0.06] |
| Writing quality | 4.37 → 3.70 | −0.67 [−0.97, −0.37] clear |

| Results with … | Live | Targeted |
|---|---|---|
| an invented detail | 1 of 33 | 3 of 33 |
| a wrong gap | 6 of 33 | 3 of 33 |
| an irrelevant edit | 23 of 33 | 3 of 33 |
| a harmful edit | 23 of 33 | 16 of 33 |

Job alignment scale: 1 = no or cosmetic edits despite clear opportunities, 2 = mostly generic rewording, 3 = a mix of targeted and generic edits, 4 = mostly targeted, 5 = every edit targets an important supported requirement. Both versions sit near 2: reviewers see most edits as generic, which is the main precision problem still to solve. Writing quality is compared on the 30 pairs where both results had edits.

**Why it was not shipped**

| Rule | Result | Verdict |
|---|---|---|
| Invented details (limit +1 point) | 1 → 3 of 33, +6 points | fail |
| No edit changes a number | 1 edit changed "three" to "seventy-five" | fail |
| Faithfulness (limit −0.1) | −0.18 | fail |
| Fit-report accuracy (limit −0.1) | −0.31 | fail |
| Job alignment (+0.3, clear) | +0.36, lower end of the interval about zero | pass, just |
| Wrong gaps (limit +2 points) | 6 → 3 of 33, mostly from the degree fix already shipped | pass |
| Failed results (limit +2 points) | none | pass |
| Median time (limit +10%) | 91 s → 60 s | pass |
| Cost per result (limit +50%) | not measured: no token counts through the ChatGPT sign-in | open |

The invented-detail flags come from single reviewers and have not had the planned second review. The rule uses the counts themselves; the interval for that change is −6 to +18 points, so 33 pairs cannot tell 1 from 3 apart with confidence. The number change happened when an edit replaced a bullet with a copy of another bullet, so a spelled-out number changed and the digit-only check missed it.

**What the reviewers pointed to.** Read for themes, the notes on the 33 targeted results most often said:

- edit slots were left unused (about 22 of 33; live: none);
- the fit report left out requirements (22; live: 3), because the targeted version kept at most 12 requirements per job, while the live version lists a median of 17 on dev pairs and 15 on held-back pairs;
- supported job wording was missed, a criticism made of both versions in most results;
- awkward wording (about 6; live: 1) and present tense for a past job (about 4; live: 1);
- dropped details (an outcome, a scope word, a duty), one weakened verb, and invented details in 3 results, such as describing a test pipeline as deploying the project.

An earlier targeted version, graded in a separate batch, had invented details in 5 of 33 results and lower faithfulness and fit-report scores, but a larger job-alignment gain (+0.85). With different reviewers and 33 pairs, the drop from 5 to 3 may be noise. It is also not an independent check: the final writing prompt names the words behind 4 of those 5 cases. Because the held-back pairs were used for both versions, they now count as development pairs. That is why the final check uses new pairs.

On 26 dev pairs, reviewed against the live version's own replies with only the per-edit checks added, the targeted writer had looked clearly better (job alignment +0.85 [0.35, 1.35], no invented details), but much of that gain disappeared on the held-back pairs. A review on dev pairs is only a screen.

## 5. In progress: ship3

**What changes compared with the targeted writer**

1. **Fact-check.** One extra short AI call runs after the draft is final. It compares every edit with its original bullet and with the other lines of the same job or project. It is asked to remove an edit that claims something they do not state: a new task, tool, number, purpose, outcome, audience, qualifier or a higher level of responsibility. It does not look for weakened wording; only the writing rules cover that. An edit without a clear "keep" is removed. If the fact-check call fails or returns unreadable output, the whole result is rejected.
2. **Writing rules.** Keep every detail, number, list item and scope word. Keep each verb's level of responsibility, never weaker and never stronger. Use past tense for past jobs. Never move a fact in from the skills list or another job. Leave a bullet unchanged rather than write an awkward line.
3. **Fuller fit report.** Up to 20 requirements instead of 12.
4. **Reading and matching in one AI call.** This keeps every job within the hosted site's limits of 4 AI calls and 6 cents: read and match, write, shorten (only if too long), fact-check. But the combined call is long. It ran past the hosted 60-second limit per call in 17 of 77 dev results (live 5, targeted 0), measured through ChatGPT. On the hosted site those results would fail, so this must be fixed before ship3 can ship.

**Fact-check test, 682 edits.** The edits came from 164 graded results of the targeted versions. An edit cited in a reviewer's invented-detail or harmful-edit flag carries that label; every other edit counts as fine.

| Reviewer label | Removed by the fact-check |
|---|---|
| Invented detail | 10 of 10 |
| Harmful | 25 of 61 (41%) |
| Fine | 157 of 611 (26%) |

These are best-case numbers. Three versions of the check were tried on these same edits, and its examples were taken from these test edits, including 6 of the 10 invented-detail cases. The new pairs are the real test. In a random sample of 50 of the 157 "fine" edits it removed, about 3 in 10 added a small unstated detail. The rest were false alarms: rewordings, details the bullet or job title already implies, details stated elsewhere in the same entry, and a few pure deletions. So the check currently removes some harmless edits. A version that saw only the bullet, without the rest of the entry, removed more fine edits (34%).

**Dev run, 77 pairs.** Automatic measures only; no reviewer scores yet.

| 77 dev pairs | Live | Targeted | ship3 |
|---|---|---|---|
| Delivered | 70 | 77 | 76 |
| Edits per result (average) | 9.7 | 3.2 | 3.1 |
| Edits on a requirement's bullet | 61% | 100% | 100% |
| Supported must-haves touched | 82% | 75% | 60% |
| … given the job's wording | 3% | 7% | 3% |
| Job keywords removed per result | 0.76 | 0.10 | 0.12 |
| Results with no real edits | 0 | 2 | 6 |
| Requirements in the fit report (median) | 17 | 12 | 18 |
| Median time | 86.6 s | 60.2 s | 75.2 s |

The fact-check ran on 74 results and removed 56 of 311 edits (18%; this count includes punctuation-only edits). 39 results lost at least one edit. Of the 6 results left with no real edits, 5 were realistic applications, and in 4 of them the fact-check removed the last real edit. One result failed, for the structural reason described below.

Most of ship3's caution comes from the fact-check. With the 56 removed edits put back, ship3 would touch 74% of supported must-haves (76% within its first 12 requirements, the same as the targeted writer), give the job's wording to 6% (targeted: 7%) and leave 2 results without edits. Listing 20 requirements instead of 12 explains about 2 points; the stricter writing rules show no clear effect. ship3 is about 11 s faster than the live version by median and 15 s slower than the targeted writer. Reading and matching takes 49.8 s (targeted: 44.2 s in two calls), writing 20.9 s (targeted: 15.9 s) and the fact-check 4.6 s.

**Two failures the tests caught in the combined call.** Once, the AI wrote the resume facts and their matches to requirements, then repeated those keys with empty lists; JSON parsing keeps the last copy, so the facts were lost. The prompt no longer shows a sample reply for that case and asks for each key once. Another time, the AI put the facts and matches inside the job section. ship3 will accept that shape before the final check. The live version's separate calls never had either problem in their recorded replies.

**Next iteration: ship3b, running on the dev pairs now.** It accepts the nested reply and uses made-up prompt examples. It adds code checks for spelled-out numbers and for an edit that copies another bullet. Its fact-check must also quote the exact words it thinks are unsupported, and code keeps the edit if all of those words appear in the bullet or its entry. On the same 682 labelled edits, this removed 101 fine edits instead of 157 (17% instead of 26%), still removed all 10 invented details, and removed 17 harmful edits instead of 25. It does not fix the 60-second problem yet.

## 6. Speed

| Median time, 77 dev pairs | |
|---|---|
| Live version | 86.6 s |
| Targeted writer | 60.2 s |
| ship3 | 75.2 s |

In the live version, most of the time goes to reading the job and resume (median 39 s on held-back pairs), then writing (28 s) and matching (21 s).

**Local use.** On the same 6 dev pairs, gpt-6-luna at low effort took a median of 60 s, against 114 s for gpt-6.1-sol at its default effort (run with an earlier version of the targeted code; only the writing prompt differs). Quality was not compared. The local version has no effort setting today and preselects the first model ChatGPT lists, so using luna at low effort would need a small code change.

## 7. Next steps

1. Done in ship3b: accept facts and matches nested inside the job section, and use made-up prompt examples instead of ones written from test cases.
2. Fix the 60-second problem: split the combined call again or shorten its reply, and count any call over 60 s as a failed result in the final check. Estimate the cost per result from request and reply sizes.
3. Cut the fact-check's false alarms further, so ship3 keeps more harmless edits and uses the job's wording where the resume supports it (ship3b's quote check is a first step). Screen the result with AI reviewers on 26 dev pairs.
4. Run the final check on the 32 new pairs: today's version against the final ship3, AI reviewers, the same ship rules. Add the planned second review of every invented-detail flag.
5. If ship3 passes, ask you before shipping, because it changes what the AI writes. Then update the docs and the progress screen text. If it fails, keep today's version and report which rule failed.
6. Separately, for today's version: extend the number check to spelled-out numbers and to edits that copy another bullet (both written and tested in ship3b).
7. Open questions for you, any time: whether the local version should use gpt-6-luna at low effort, and whether you want to spot-check 10 random results and every confirmed invented detail before anything ships (the original plan included this).

## Appendix: definitions

- **Held-back pairs**: test pairs kept aside while building a change and used only to check it. Once used to make changes, they count as development pairs.
- **Live version** (sections 4 to 6): the version before the safe fixes.
- **Edit on a requirement's bullet**: the edited bullet is the resume's evidence for a job requirement, or contains one of the requirement's terms (its keywords or wording).
- **Supported must-haves touched**: of the must-have requirements the resume has evidence for, the share whose evidence bullet was edited. **… given the job's wording**: the share where an edit added one of the requirement's terms.
- **Job keyword removed**: a keyword from the job's requirements that was in the bullet before the edit and is gone after it.
- **Invented detail**: a reviewer found a claim in the result that the original resume does not support.
- **Wrong gap**: the fit report lists a requirement as something to learn although the original resume clearly shows it.
- **Irrelevant edit**: an edit that serves no requirement of this job.
- **Harmful edit**: an edit that loses or blurs a fact, changes its meaning, adds an error or keyword stuffing, or credits work to the wrong role.
- **Rejected draft**: the final checks refused the AI's draft, so the user got an error instead of a resume.
- **Failed result**: any product failure: a rejected draft, an unreadable or incomplete AI reply, a result over its page limit, or a time-out on the hosted site. Network time-outs between the test machine and ChatGPT are not counted.
- **No real edits**: no edit that changes words; changes to punctuation or capital letters only do not count.
- **Median**: the middle value; for an even count, the average of the two middle values.
