# Examples

Generic before/after cases. The code is TypeScript with Vitest-style `describe`/`it` for readability; the
reasoning is the same in any language.

## 1. The same rule tested at two levels

Before: a pure permission function has a full test matrix, and the endpoint's tests repeat most of it.

```ts
// rules.test: 12 cases — owner, editor, viewer, overrides, legacy roles...
// controller.test: "viewer can't delete own file", "override removes delete_own",
//                  "editor can't delete others' file", "owner can delete any"...  (same matrix again)
```

After: the matrix stays in the rules test (cheap, exhaustive). The endpoint test proves the wiring once each way,
plus what only the endpoint can get wrong:

```ts
it('lets an allowed member delete and stores the soft delete', ...);   // wiring: allowed
it('answers 403 to a denied member and writes nothing', ...);           // wiring: denied
it('answers 404 for a file of another workspace', ...);                 // scoping: only the endpoint can get it wrong
```

## 2. Mapper / DTO tests

Before: a test asserts every field of the response object.

After: delete it. The type checker guarantees the shape. Keep only the one thing types can't see, inside the
endpoint's integration test: "the response doesn't contain internal columns" (`expect(body).not.toHaveProperty('deleted_at')`).

## 3. Testing implementation details

Before:

```ts
it('passes the validated id to the controller', () => {
  expect(validated.data.workspaceId).toBe(WS);       // breaks on any refactor, catches no bug
});
it('calls the repository once', () => {
  expect(repo.update).toHaveBeenCalledTimes(1);       // asserts on a mock, not on behavior
});
```

After: assert what a caller observes.

```ts
it('revokes the invite of the workspace in the URL', async () => {
  const res = await api.delete(`/workspaces/${A}/invites/${inviteOfA}`).auth(ownerOfA);
  expect(res.status).toBe(204);
  expect(await invites.find(inviteOfA)).toBeNull();
});
it('answers 404 when the invite belongs to another workspace', async () => {
  const res = await api.delete(`/workspaces/${A}/invites/${inviteOfB}`).auth(ownerOfA);
  expect(res.status).toBe(404);
  expect(await invites.find(inviteOfB)).not.toBeNull();   // nothing written
});
```

## 4. One test per variant → a table of cases

Before: five tests that each call the parser with a different legacy shape and check the same output.

After:

```ts
it.each([
  ['wrapped pages', { pages: [page] }],
  ['legacy sections', [section]],
  ['legacy bare blocks', [block]],
  ['string shorthand', 'hello'],
])('extracts the text from %s', (_name, input) => {
  expect(extractText(input)).toBe('hello');
});
```

## 5. A mock that hid a real bug

Before: the endpoint test mocks the repository, so a query selecting a column that doesn't exist passes every test
and fails on every request in production.

After: an integration test with a throwaway database built by the real migrations:

```ts
beforeAll(async () => {
  db = await startPostgres();          // Testcontainers / compose service
  await runMigrations(db);             // the real migrations: also tests them
});
beforeEach(() => db.query('BEGIN'));
afterEach(() => db.query('ROLLBACK'));

it('promotes a thought for an editor', async () => {
  const { thought, editor } = await seed.workspaceWithThought();
  const res = await api.post(`/thoughts/${thought.id}/promote`).auth(editor);
  expect(res.status).toBe(201);
});
```

## 6. A permission check that silently disappeared

A library bug made an async validation step never run, so non-members could write. Every positive test still
passed. Only a negative test would have failed:

```ts
it('refuses a non-member (and writes nothing)', async () => {
  const res = await api.put(`/notes/${note.id}`).auth(outsider).send({ title: 'x' });
  expect([403, 404]).toContain(res.status);
  expect((await notes.find(note.id)).title).toBe(note.title);
});
```

Every endpoint that checks membership or roles gets at least one of these.

## 7. Front end: what to test

- Pure logic (diffing, URL signing/caching, serialized saves, formatters with branches): unit tests.
- A component whose behavior depends on state or permissions (an upload panel hidden without permission, a file
  block showing "unavailable"): Testing Library with the network faked at the boundary (MSW), real child components.
- Translation files: a script that fails when locales have different keys (static check, not a test per key).
- The 3–5 journeys users can't live without: Playwright against a running app.
- Not: that a design-system button renders, snapshots of whole pages, styles.
