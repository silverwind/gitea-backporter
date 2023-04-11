import * as semver from "https://deno.land/std@0.182.0/semver/mod.ts";
import { getPrBranchName } from "./git.ts";
import { GiteaVersion } from "./giteaVersion.ts";

const GITHUB_API = "https://api.github.com";
const HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${Deno.env.get("BACKPORTER_GITHUB_TOKEN")}`,
};

// return the current user
export const fetchCurrentUser = async () => {
  const response = await fetch(`${GITHUB_API}/user`, { headers: HEADERS });
  return response.json();
};

// returns a list of PRs that are merged and have the backport label for the current Gitea version
export const fetchCandidates = async (giteaMajorMinorVersion: string) => {
  const response = await fetch(
    `${GITHUB_API}/search/issues?q=` +
      encodeURIComponent(
        `is:pr is:merged label:backport/v${giteaMajorMinorVersion} -label:backport/done -label:backport/manual repo:go-gitea/gitea`,
      ),
    { headers: HEADERS },
  );
  const json = await response.json();
  for (const item of json.items) {
    console.log(`- ${item.title} (#${item.number})`);
  }
  return json;
};

// returns a list of PRs that are merged and have the given label
export const fetchMergedWithLabel = async (label: string) => {
  const response = await fetch(
    `${GITHUB_API}/search/issues?q=` +
      encodeURIComponent(
        `is:pr is:merged label:${label} repo:go-gitea/gitea`,
      ),
    { headers: HEADERS },
  );
  const json = await response.json();
  return json;
};

// returns a list of PRs pending merge (have the label reviewed/wait-merge)
export const fetchPendingMerge = async () => {
  const response = await fetch(
    `${GITHUB_API}/search/issues?q=` +
      encodeURIComponent(
        `is:pr is:open label:reviewed/wait-merge sort:created-asc repo:go-gitea/gitea`,
      ),
    { headers: HEADERS },
  );
  const json = await response.json();
  return json;
};

// update a given PR with the latest upstream changes by merging HEAD from
// the base branch into the pull request branch
export const updatePr = async (prNumber: number): Promise<Response> => {
  const pr = await fetchPr(prNumber);
  const response = await fetch(
    `${GITHUB_API}/repos/go-gitea/gitea/pulls/${prNumber}/update-branch`,
    {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ expected_head_sha: pr.head.sha }),
    },
  );
  return response;
};

// given a PR number that has the given label, remove the label
export const removeLabel = async (
  prNumber: number,
  label: string,
) => {
  const response = await fetch(
    `${GITHUB_API}/repos/go-gitea/gitea/issues/${prNumber}/labels/${label}`,
    { method: "DELETE", headers: HEADERS },
  );
  return response;
};

// returns the PR
export const fetchPr = async (prNumber: number) => {
  const response = await fetch(
    `${GITHUB_API}/repos/go-gitea/gitea/pulls/${prNumber}`,
    { headers: HEADERS },
  );
  return response.json();
};

// returns true if a backport PR exists for the given PR number and Gitea version
export const backportPrExists = async (
  pr: { number: number },
  giteaMajorMinorVersion: string,
) => {
  const response = await fetch(
    `${GITHUB_API}/search/issues?q=` +
      encodeURIComponent(
        `is:pr is:open repo:go-gitea/gitea base:release/v${giteaMajorMinorVersion} ${pr.number} in:title`,
      ),
    { headers: HEADERS },
  );
  const json = await response.json();
  return json.total_count > 0;
};

type Milestone = { title: string };

// get Gitea milestones
export const getMilestones = async (): Promise<Milestone[]> => {
  const response = await fetch(
    `${GITHUB_API}/repos/go-gitea/gitea/milestones`,
    { headers: HEADERS },
  );
  const json = await response.json();
  const milestones: Milestone[] = json.filter((m: Milestone) =>
    semver.valid(m.title)
  );

  // take only the earliest patch version of each minor version (e.g. 1.19.0, 1.19.1, 1.19.2 -> 1.19.0)
  const earliestPatchVersions: Record<string, Milestone> = {};
  for (const milestone of milestones) {
    const version = new semver.SemVer(milestone.title);
    const key = `${version.major}.${version.minor}`;
    if (
      !earliestPatchVersions[key] ||
      semver.lt(milestone.title, earliestPatchVersions[key].title)
    ) {
      earliestPatchVersions[key] = milestone;
    }
  }

  return Object.values(earliestPatchVersions);
};

export const getPrApprovers = async (prNumber: number) => {
  const response = await fetch(
    `${GITHUB_API}/repos/go-gitea/gitea/pulls/${prNumber}/reviews`,
    { headers: HEADERS },
  );
  const json = await response.json();

  const approvers = json
    .filter((review: { state: string }) => review.state === "APPROVED")
    .map((r: { user: { login: string } }) => r.user.login);

  // return unique approvers
  return [...new Set(approvers)];
};

export const createBackportPr = async (
  originalPr: {
    title: string;
    number: number;
    body: string;
    labels: [{ name: string }];
    user: { login: string };
  },
  giteaVersion: GiteaVersion,
) => {
  let prDescription =
    `Backport #${originalPr.number} by @${originalPr.user.login}`;
  if (originalPr.body) {
    prDescription += "\n\n" + originalPr.body;
  }
  let response = await fetch(`${GITHUB_API}/repos/go-gitea/gitea/pulls`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      title: `${originalPr.title} (#${originalPr.number})`,
      head: `${Deno.env.get("BACKPORTER_GITEA_FORK")?.split("/")[0]}:${
        getPrBranchName(
          originalPr.number,
          giteaVersion.majorMinorVersion,
        )
      }`,
      base: `release/v${giteaVersion.majorMinorVersion}`,
      body: prDescription,
      maintainer_can_modify: true,
    }),
  });
  const json = await response.json();
  console.log("Created backport PR");
  console.log(json);

  // filter lgtm/*, backport/* and reviewed/* labels
  const labels = originalPr.labels
    .map((label) => label.name)
    .filter((label) => {
      return (
        !label.startsWith("lgtm/") &&
        !label.startsWith("backport/") &&
        !label.startsWith("reviewed/")
      );
    });

  // add labels
  response = await fetch(
    `${GITHUB_API}/repos/go-gitea/gitea/issues/${json.number}/labels`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ labels }),
    },
  );

  // set milestone
  await fetch(
    `${GITHUB_API}/repos/go-gitea/gitea/issues/${json.number}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({
        milestone: giteaVersion.milestoneNumber,
      }),
    },
  );

  // set assignee
  await fetch(
    `${GITHUB_API}/repos/go-gitea/gitea/issues/${json.number}`,
    {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({
        assignees: [originalPr.user.login],
      }),
    },
  );

  // request review from original PR approvers
  const approvers = await getPrApprovers(originalPr.number);
  await fetch(
    `${GITHUB_API}/repos/go-gitea/gitea/pulls/${json.number}/requested_reviewers`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ reviewers: approvers }),
    },
  );

  // if the original PR had exactly one backport/* label, add the backport/done label to it
  const backportLabels = originalPr.labels
    .filter((label) => label.name.startsWith("backport/"));
  if (backportLabels.length === 1) {
    await addLabels(originalPr.number, ["backport/done"]);
  }
};

export const addLabels = async (prNumber: number, labels: string[]) => {
  const response = await fetch(
    `${GITHUB_API}/repos/go-gitea/gitea/issues/${prNumber}/labels`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ labels: labels }),
    },
  );
  await response.json();
  console.log(
    `Added backport/done label to PR #${prNumber}`,
  );
};

export const addPrComment = async (prNumber: number, comment: string) => {
  const response = await fetch(
    `${GITHUB_API}/repos/go-gitea/gitea/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ body: comment }),
    },
  );
  await response.json();
  console.log(
    `Added backport comment to PR #${prNumber}`,
  );
};
