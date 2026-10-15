export const studentResume = `Alex Rivera
alex@example.com | Edmonton, AB | github.com/alexrivera
SUMMARY
Computer science student with experience building accessible web applications and reliable data tools.
EDUCATION
Bachelor of Science in Computer Science | Western University | Expected 2027
Relevant coursework: software engineering, databases, algorithms and human-computer interaction.
EXPERIENCE
Software Developer Intern | Northstar | May 2025 - August 2025
- Built React dashboards for operations.
- Connected dashboard components to REST endpoints and added clear loading and error states.
- Wrote automated checks for form validation and worked with designers to improve keyboard navigation.
- Investigated reported defects, documented reproduction steps and reviewed fixes with the engineering team.
Teaching Assistant | Western University | September 2024 - April 2025
- Helped students debug Python programs and understand data structures during weekly lab sessions.
- Reviewed assignments against course rubrics and explained practical ways to improve readability.
PROJECTS
Campus Events Directory | React, Node.js, SQLite
- Built a searchable directory with location filters and links to original event organizers.
- Designed database tables and wrote integration checks for saved events and search filters.
Study Planner | Python, PostgreSQL
- Created a planner that groups coursework by deadline and displays progress for each class.
- Documented setup steps and tested scheduling logic with missing and overlapping deadlines.
SKILLS
JavaScript, TypeScript, React, Node.js, Python, SQL, Git, REST APIs, accessibility, automated testing.
VOLUNTEER EXPERIENCE
Coding Club Mentor | Western University | 2024 - 2025
- Helped new members build small web projects and review each other's code.`;

export const denseResume = `${studentResume}\nADDITIONAL EXPERIENCE\n${Array.from({ length: 12 }, () => '- Reviewed support reports, reproduced application defects and documented fixes for the next release.').join('\n')}`;

export const twoPageResume = `${studentResume}\nADDITIONAL EXPERIENCE\n${Array.from({ length: 30 }, () => '- Collaborated with product designers to review interface behavior and document accessible interaction patterns.').join('\n')}`;

export const overflowingResume = `${studentResume}\n${Array.from({ length: 90 }, () => '- Built React dashboards for operations.').join('\n')}`;
