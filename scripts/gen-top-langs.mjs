// Generate top-languages SVGs weighted by my commit count across all branches.
//
// The stock top-langs card hardcodes ownerAffiliations: OWNER and counts raw
// repo bytes, so collaborator/org repos (moondeuk, team projects) are missing
// and teammates' code gets credited to me. GitHub's official contribution
// graph is no help either: it only counts the default branch, and org-private
// contributions are hidden behind restrictedContributionsCount. Instead:
//   1. Collect owned + collaborator + org repos, plus repos I've committed to.
//   2. Count my unique commits across ALL branches of each repo.
//   3. Score languages as (my commits) x (repo's language byte fraction),
//      so a repo I never committed to contributes nothing.
//   4. Render with the official renderer for identical styling.
//
// The package's exports map only exposes its index, which doesn't re-export
// card renderers — import the built card module by file path instead.
import { writeFile, mkdir } from "node:fs/promises";
import { renderTopLanguages } from "../node_modules/@stats-organization/github-readme-stats-core/build/cards/top-languages.js";

const token = process.env.GH_TOKEN;
if (!token) throw new Error("GH_TOKEN is required");
const username = process.env.GH_USERNAME;
if (!username) throw new Error("GH_USERNAME is required");

const MAX_BRANCHES = 60;

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

async function myCommitsAllBranches(owner, name) {
  const data = await gql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        refs(refPrefix: "refs/heads/", first: ${MAX_BRANCHES}) {
          nodes { name }
        }
      }
    }`,
    { owner, name },
  );
  const oids = new Set();
  for (const { name: branch } of data.repository.refs.nodes) {
    let cursor = null;
    do {
      let history;
      try {
        const d = await gql(
          `query($owner: String!, $name: String!, $branch: String!, $authorId: ID!, $cursor: String) {
            repository(owner: $owner, name: $name) {
              ref(qualifiedName: $branch) {
                target {
                  ... on Commit {
                    history(author: { id: $authorId }, first: 100, after: $cursor) {
                      pageInfo { hasNextPage endCursor }
                      nodes { oid }
                    }
                  }
                }
              }
            }
          }`,
          { owner, name, branch: `refs/heads/${branch}`, authorId: myId, cursor },
        );
        history = d.repository.ref.target.history;
      } catch {
        break; // branch deleted mid-run or non-commit target — skip
      }
      for (const n of history.nodes) oids.add(n.oid);
      cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (cursor);
  }
  return oids.size;
}

const langs = {};
let included = 0;
for (const full of repos) {
  const [owner, name] = full.split("/");
  let edges;
  try {
    const d = await gql(
      `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { color name } }
          }
        }
      }`,
      { owner, name },
    );
    edges = d.repository.languages.edges;
  } catch {
    continue; // repo gone or inaccessible — skip
  }
  if (!edges.length) continue;
  const mine = await myCommitsAllBranches(owner, name);
  if (mine === 0) continue;
  included++;
  const totalBytes = edges.reduce((sum, e) => sum + e.size, 0);
  for (const { size, node } of edges) {
    langs[node.name] ??= { name: node.name, color: node.color, size: 0 };
    langs[node.name].size += (mine * size) / totalBytes;
  }
}
// renderer expects integer sizes; scale up to keep precision
for (const lang of Object.values(langs))
  lang.size = Math.round(lang.size * 1000);

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
