// An interview message in the answer format that INTERVIEW_RULES prescribes (`<n>. <answer>`), shared by the
// prompt test and the parser test so that the prompt's contract and the parser cannot drift apart.
export const NUMBERED_MESSAGE = `Which database should the service use? The reason: the schema depends on it.
1. PostgreSQL - the default, already in the container
2. SQLite - no server needed
3. Both, chosen by configuration
Default: 1`;
