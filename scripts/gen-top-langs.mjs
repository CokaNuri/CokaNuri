// Generate top-languages SVGs weighted by my actual commit share.
//
// The stock top-langs card hardcodes ownerAffiliations: OWNER, so collaborator
// and organization repos (moondeuk, team projects) never show up, and raw
// byte counts credit teammates' code to me. Instead:
//   1. Collect owned + collaborator + org repos, plus repos I've committed to.
//   2. Weight each repo's language bytes by (my commits / total commits) on
//      the default branch — repos I never committed to drop out naturally.
//   3. Render with the official renderer for identical styling.
import { writeFile, mkdir } from "node:fs/promises";
import { renderTopLanguages } from "@stats-organization/github-readme-stats-core";

const token = process.env.GH_TOKEN;
if (!token) throw new Error("GH_TOKEN is required");
const username = process.env.GH_USERNAME;
if (!username) throw new Error("GH_USERNAME is required");

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const { data, errors } = await res.json();
  if (errors) throw new Error(JSON.stringify(errors));
  return data;
}

const { user: { id: myId } } = await gql(
  `query($login: String!) { user(login: $login) { id } }`,
  { login: username },
);

const repos = new Set();
let after = null;
do {
  const data = await gql(
    `query($login: String!, $after: String) {
      user(login: $login) {
        repositories(
          ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
          isFork: false
          first: 100
          after: $after
        ) {
          pageInfo { hasNextPage endCursor }
          nodes { nameWithOwner }
        }
      }
    }`,
    { login: username, after },
  );
  const page = data.user.repositories;
  for (const n of page.nodes) repos.add(n.nameWithOwner);
  after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
} while (after);

const contributed = await gql(
  `query($login: String!) {
    user(login: $login) {
      repositoriesContributedTo(first: 100, contributionTypes: [COMMIT]) {
        nodes { nameWithOwner }
      }
    }
  }`,
  { login: username },
);
for (const n of contributed.user.repositoriesContributedTo.nodes)
  repos.add(n.nameWithOwner);

const langs = {};
let included = 0;
for (const full of repos) {
  const [owner, name] = full.split("/");
  let repo;
  try {
    ({ repository: repo } = await gql(
      `query($owner: String!, $name: String!, $authorId: ID!) {
        repository(owner: $owner, name: $name) {
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { color name } }
          }
          defaultBranchRef {
            target {
              ... on Commit {
                total: history { totalCount }
                mine: history(author: { id: $authorId }) { totalCount }
              }
            }
          }
        }
      }`,
      { owner, name, authorId: myId },
    ));
  } catch {
    continue; // repo gone or inaccessible — skip
  }
  const target = repo?.defaultBranchRef?.target;
  if (!target?.total?.totalCount) continue;
  const weight = target.mine.totalCount / target.total.totalCount;
  if (weight === 0) continue;
  included++;
  for (const { size, node } of repo.languages.edges) {
    langs[node.name] ??= { name: node.name, color: node.color, size: 0 };
    langs[node.name].size += size * weight;
  }
}
for (const lang of Object.values(langs)) lang.size = Math.round(lang.size);

console.log(
  `${repos.size} repos scanned, ${included} with my commits, ${Object.keys(langs).length} languages`,
);

const common = {
  layout: "compact",
  hide_border: true,
  locale: "kr",
  langs_count: 8,
};
await mkdir("profile", { recursive: true });
await writeFile("profile/top-langs-light.svg", renderTopLanguages(langs, common));
await writeFile(
  "profile/top-langs-dark.svg",
  renderTopLanguages(langs, { ...common, theme: "tokyonight" }),
);
console.log("Wrote profile/top-langs-{light,dark}.svg");
