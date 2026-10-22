# Resume quality approach

The hosted website uses a server-funded, fixed OpenAI API model. The separate local studio uses the user’s selected model through their authorized ChatGPT plan. Both adapters feed the same evidence and editing pipeline. This project does not fine-tune or retrain a model: it improves the model's instructions, supplies verified source evidence, and checks the response before displaying it.

## GitHub projects reviewed

| Project | Useful approach | Applied here |
|---|---|---|
| [OpenResume](https://github.com/xitanggg/open-resume) | Conventional, consistent sections and PDF formatting; resume parsing as a check on readability | The preview and exports now use a clear name, section, and bullet hierarchy. |
| [Markdown Resume](https://github.com/junian/markdown-resume) | Restrained single-column layout, readable type, and practical print output | The generated text uses familiar headings and one-column content instead of decorative formatting. |
| [Resume AI](https://github.com/resume-llm/resume-ai) | A concise role-specific writing prompt, editable drafts, and DOCX/PDF export | The writing prompt emphasizes relevant evidence and concise bullets; the existing editable input and exports remain. |

These are design references. No source code was copied from those repositories.

## Rules used in this project

1. The original resume is the only evidence for the candidate's facts. The job posting guides selection and wording.
2. Preserve contact details, education, employers, titles, dates, and other source sections.
3. Reject claim citations whose quoted phrase is absent from the original resume and use the source quote as the claim text. Ignore malformed extracted items individually.
4. Validate claim and requirement IDs before calculating coverage. Unsupported requirements stay out of the resume.
5. Ask for small edits to identified source bullets, retaining their purpose, domain and main achievements. Apply edits to the original text so every unedited line, role and project remains. Enforce the edit cap and check each edit on its own: drop new/deleted/multiline bullets, copies of another bullet, changed numbers (in digits or words), removed contact details and unsupported or misplaced key terms, and keep the valid edits. Show original/revised bullets for review.
6. Render the same plain-text structure in the preview, PDF, and DOCX.
7. Keep the output within the original PDF's page count, or the selected limit for pasted text. Measure actual line wrapping before accepting the result and use the same layout for export. Allow one concise editing pass on overflow, then return an error if it still cannot fit. Never silently truncate content or reduce body text below 10.5 pt.

8. Compute the match score from source evidence, giving partial credit to transferable evidence. Verify quoted placement in the final draft. Separate included experience, evidence to expand, and absent requirements to learn or substantiate; never treat missing resume evidence as proof of inability.
9. Save original inputs and completed drafts/reports to the available application store (local files or a verified user’s Supabase library). Hosted guest results are downloadable but do not have an account library. Progress edits must not mutate old resume versions. Storage failures must not lose a completed result.

## Evaluation

`npm test` covers source grounding, malformed claims, requirement coverage, missing contact/education, invented numbers, shared output structure, PDF page counts, text retention and overflow recovery. `tests/fixtures/resumes.js` supplies synthetic standard, dense, two-page and oversized cases. Render PDF and DOCX exports when changing layout; verify both page counts and visual legibility. DOCX uses explicit breaks and shared wrapping, but edits and font substitutions may change pagination. The PDF keeps fixed page geometry. A live hosted end-to-end check spends API credit and allowance; use a synthetic resume on a protected stage. A local end-to-end check instead requires a connected eligible ChatGPT plan. Mocked tests do not spend provider credit.

The checks are intentionally narrow. They do not establish semantic truth for every rewritten sentence, and the fit score is an evidence estimate rather than an ATS result or hiring prediction. Learning suggestions are coaching, not verified evidence of completed experience.
