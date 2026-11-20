NoteStar Installation Guide
===========================

Version 0.3.5
-------------
Full Markdown with a formatting toolbar and a cheat sheet, and pictures:
paste, drop or insert them, resize them in the preview, and find them in
the notes tree. They are kept in an "attachments" folder next to the
note and synced along with the notes. See whatsnew.txt for the release
history.

The main-window Donate button appears after 10 minutes of foreground
use. The timer pauses while the window is unfocused or hidden and
resets each time NoteStar starts. You can also donate from the About
dialog at any time.

Download
--------
On the GitHub Actions page for a successful "Build installers" run,
download the ZIP for your platform from Artifacts and extract it.

Windows x64 and ARM64
---------------------
1. Open Settings > System > About and check System type.
2. For an x64 processor, choose the NSIS .exe from the
   NoteStar-x86_64-pc-windows-msvc artifact. For an ARM processor, choose
   the .exe from NoteStar-aarch64-pc-windows-msvc.
3. Run the NoteStar .exe installer. If the WebView2 Runtime is missing,
   the installer downloads it, which requires an internet connection.
   SmartScreen may warn about the unsigned installer. If you have
   verified the download source, select "More info" and then "Run anyway"
   if Windows offers that option.
4. Open NoteStar from the Start menu.

macOS Apple Silicon (ARM64) and Intel (x64)
------------------------------------------
1. Open Apple menu > About This Mac and check the chip or processor.
   For an Apple M-series chip, choose the .dmg from
   NoteStar-aarch64-apple-darwin. For an Intel processor, choose the .dmg
   from NoteStar-x86_64-apple-darwin.
2. Open the .dmg, drag NoteStar.app into Applications, and eject the disk
   image.
3. Open NoteStar from Applications. If Gatekeeper blocks the app because
   the developer cannot be verified, check the download source. After
   the first launch attempt, open System Settings > Privacy & Security,
   choose "Open Anyway" if available, and confirm.
   Apple guide: https://support.apple.com/en-ie/102445
4. If macOS says that "NoteStar is damaged and can't be opened", or
   "Open Anyway" does not appear, remove the quarantine flag. The app is
   not signed by Apple, so macOS blocks it. Run this in Terminal after
   copying the app to Applications:

     xattr -dr com.apple.quarantine /Applications/NoteStar.app

   If it still does not open, clear all extended attributes:

     xattr -cr /Applications/NoteStar.app

   Repeat this after installing a new version, including one installed by
   the self-update.

Linux x64
---------
Run "uname -m" and confirm that it reports x86_64. The
NoteStar-x86_64-unknown-linux-gnu artifact contains three formats.
Run the commands from the download folder and replace the example
filenames with the actual filenames.

Debian or Ubuntu (.deb)
  sudo apt update
  sudo apt install ./NoteStar_amd64.deb

Fedora or another DNF-based distribution (.rpm)
  sudo dnf install ./NoteStar.x86_64.rpm

AppImage
  chmod +x ./NoteStar_amd64.AppImage
  ./NoteStar_amd64.AppImage

  If you get a FUSE error, install your distribution's FUSE 2
  compatibility package (libfuse2 on Ubuntu 22.04 or libfuse2t64 on
  Ubuntu 24.04).

Where the notes and settings are
--------------------------------
The notes are plain files in the notes folder (default
Documents/NoteStar, changeable in Settings > Notes). Sync targets,
tokens and API keys are in settings.json in the app configuration
folder (Windows: %APPDATA%\hu.notestar.app). Use About > Settings
folder to open it.

Setting up sync
---------------
Settings > Sync > New sync target. A folder target can be the folder
of the OneDrive, Dropbox, Google Drive or iCloud desktop client;
NoteStar detects these. OneDrive needs your own Azure app registration
(App ID), Dropbox your own app (App key); the dialog explains the
steps. WebDAV works with Nextcloud, ownCloud, Synology and others.

License: MIT. Copyright (c) 2026 Zsolt Tarczali. See LICENSE.
Third-party components retain their own licenses.
