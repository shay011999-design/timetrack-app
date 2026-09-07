// Uploading a document has the same constraint as adding a fill-up: the site is
// static, so there is nowhere of our own to put the file. GitHub's upload route
// takes a directory and opens its drag-and-drop page there, which keeps git the
// single source of truth and lets GitHub do the authenticating.
export default function UploadDoc({ repo, dir, label, hint }) {
  if (!repo) return null;
  const url = `https://github.com/${repo.owner}/${repo.name}/upload/${repo.branch}/${dir}`;
  return (
    <a
      className="addbtn ghost"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={hint}
    >
      {label}
    </a>
  );
}
