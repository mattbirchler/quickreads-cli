# Draft Homebrew formula. On release: zip bin/ src/ package.json README.md
# LICENSE as quickreads-<version>.zip, attach it to the GitHub release, fill in
# url + sha256, and copy this file to mattbirchler/homebrew-tap/Formula/.
class Quickreads < Formula
  desc "Quick Reads in your terminal: browse, read, save, search, highlights"
  homepage "https://github.com/mattbirchler/quickreads-cli"
  url "https://github.com/mattbirchler/quickreads-cli/releases/download/v0.1.0/quickreads-0.1.0.zip"
  sha256 "FILL_IN_ON_RELEASE"
  license "MIT"

  # Runs TypeScript directly via Node's native type stripping, which needs 26.
  # No :macos dependency: the key falls back to a 0600 config file and the
  # clipboard to OSC 52 / wl-copy / xclip, so Linux is fully supported.
  depends_on "node"

  def install
    libexec.install "bin", "src", "package.json", "README.md", "LICENSE"

    # Point at Homebrew's node explicitly rather than relying on the shebang,
    # so an older node earlier in PATH cannot break the install.
    (bin/"quickreads").write <<~SH
      #!/bin/bash
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/bin/quickreads.ts" "$@"
    SH
    chmod 0755, bin/"quickreads"
  end

  test do
    assert_match "quickreads", shell_output("#{bin}/quickreads --help")
    assert_match version.to_s, shell_output("#{bin}/quickreads --version")
  end
end
