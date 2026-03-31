// Patches the Electron binary so macOS shows "The Grid" in menu bar and dock
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

if (process.platform !== 'darwin') process.exit(0)

try {
  const electronPath = require('electron')
  const plistPath = path.join(path.dirname(electronPath), '..', 'Info.plist')
  const resourcesPath = path.join(path.dirname(electronPath), '..', 'Resources')
  const iconSrc = path.join(__dirname, '..', 'build', 'icon.icns')

  // Patch app name
  execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'The Grid'" "${plistPath}"`)
  execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleName 'The Grid'" "${plistPath}"`)

  // Copy icon
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(resourcesPath, 'electron.icns'))
  }

  console.log('Patched Electron for "The Grid"')
} catch (e) {
  console.log('Electron patch skipped:', e.message)
}
