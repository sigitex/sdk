/**
 * @type {import('semantic-release').GlobalConfig}
 */
module.exports = {
  repositoryUrl: "https://code.sigitex.com/sigitex/sdk.git",
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/exec", {
      prepareCmd: "npm pkg set version=${nextRelease.version}",
      publishCmd: "npm publish --access public",
    }],
    "@markwylde/semantic-release-gitea",
  ],
};
