const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 19) {
  console.error(`Moi requires Node 24.19.x; received ${process.version}`);
  process.exit(1);
}
