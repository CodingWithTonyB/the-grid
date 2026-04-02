import Foundation
import CoreWLAN

// Method 1: CoreWLAN (best data but may hide SSIDs without Location Services)
func corewlanScan() -> [[String: Any]] {
    let client = CWWiFiClient.shared()
    guard let iface = client.interface() else { return [] }
    do {
        let networks = try iface.scanForNetworks(withSSID: nil)
        return networks.map { net in
            var sec = "Unknown"
            if net.supportsSecurity(.none) { sec = "Open" }
            if net.supportsSecurity(.WEP) { sec = "WEP" }
            if net.supportsSecurity(.wpaPersonal) { sec = "WPA" }
            if net.supportsSecurity(.wpa2Personal) { sec = "WPA2" }
            if net.supportsSecurity(.wpa3Personal) { sec = "WPA3" }
            if net.supportsSecurity(.wpaEnterprise) { sec = "WPA Enterprise" }
            if net.supportsSecurity(.wpa2Enterprise) { sec = "WPA2 Enterprise" }
            if net.supportsSecurity(.wpa3Enterprise) { sec = "WPA3 Enterprise" }
            var secLevel = 0
            if net.supportsSecurity(.none) { secLevel = 1 }
            if net.supportsSecurity(.WEP) { secLevel = 2 }
            if net.supportsSecurity(.wpaPersonal) { secLevel = 3 }
            if net.supportsSecurity(.wpa2Personal) { secLevel = 4 }
            if net.supportsSecurity(.wpa3Personal) { secLevel = 5 }
            if net.supportsSecurity(.wpaEnterprise) || net.supportsSecurity(.wpa2Enterprise) || net.supportsSecurity(.wpa3Enterprise) { secLevel = 6 }
            return [
                "ssid": net.ssid ?? "",
                "bssid": net.bssid ?? "",
                "rssi": net.rssiValue,
                "channel": net.wlanChannel?.channelNumber ?? 0,
                "band": net.wlanChannel?.channelBand.rawValue ?? 0,
                "channelWidth": net.wlanChannel?.channelWidth.rawValue ?? 0,
                "noise": net.noiseMeasurement,
                "ibss": net.ibss,
                "countryCode": net.countryCode ?? "",
                "beaconInterval": net.beaconInterval,
                "security": sec,
                "securityLevel": secLevel,
            ] as [String: Any]
        }
    } catch { return [] }
}

// Method 2: system_profiler (always shows SSIDs, less detail)
func profilerScan() -> [[String: Any]] {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/sbin/system_profiler")
    proc.arguments = ["SPAirPortDataType"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    do { try proc.run() } catch { return [] }
    proc.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let text = String(data: data, encoding: .utf8) else { return [] }

    guard let range = text.range(of: "Other Local Wi-Fi Networks:") else { return [] }
    var block = String(text[range.upperBound...])
    if let awdl = block.range(of: "awdl0:") { block = String(block[..<awdl.lowerBound]) }

    var results: [[String: Any]] = []
    var current: [String: Any]? = nil
    let infoKeys: Set<String> = ["PHY Mode","Channel","Network Type","Security","Signal / Noise","Country Code","Transmit Rate","MCS Index"]

    for line in block.components(separatedBy: "\n") {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, let colonIdx = trimmed.firstIndex(of: ":") else { continue }
        let key = String(trimmed[..<colonIdx]).trimmingCharacters(in: .whitespaces)
        let val = String(trimmed[trimmed.index(after: colonIdx)...]).trimmingCharacters(in: .whitespaces)

        if !infoKeys.contains(key) {
            if let c = current { results.append(c) }
            current = ["ssid": key, "security": "Unknown", "securityLevel": 0, "channel": 0, "band": 0, "channelWidth": 0, "rssi": 0, "noise": 0, "bssid": "", "ibss": false, "countryCode": "", "beaconInterval": 100]
        } else if current != nil {
            if key == "Security" {
                current!["security"] = val
                if val.contains("None") { current!["securityLevel"] = 1 }
                else if val.contains("WEP") { current!["securityLevel"] = 2 }
                else if val.contains("WPA3") { current!["securityLevel"] = 5 }
                else if val.contains("WPA2") { current!["securityLevel"] = 4 }
                else if val.contains("WPA") { current!["securityLevel"] = 3 }
            } else if key == "Channel" {
                // e.g. "36 (5GHz, 80MHz)"
                let parts = val.components(separatedBy: CharacterSet(charactersIn: " (,)"))
                if let ch = Int(parts[0]) { current!["channel"] = ch }
                if val.contains("2GHz") { current!["band"] = 1 }
                else if val.contains("5GHz") { current!["band"] = 2 }
                else if val.contains("6GHz") { current!["band"] = 3 }
                if val.contains("160MHz") { current!["channelWidth"] = 4 }
                else if val.contains("80MHz") { current!["channelWidth"] = 3 }
                else if val.contains("40MHz") { current!["channelWidth"] = 2 }
                else { current!["channelWidth"] = 1 }
            } else if key == "Signal / Noise" {
                let nums = val.components(separatedBy: CharacterSet.decimalDigits.inverted.subtracting(CharacterSet(charactersIn: "-")))
                    .filter { !$0.isEmpty }
                if nums.count >= 1, let sig = Int(nums[0]) { current!["rssi"] = sig }
                if nums.count >= 2, let noi = Int(nums[1]) { current!["noise"] = noi }
            }
        }
    }
    if let c = current { results.append(c) }
    return results
}

// Run both, merge: CoreWLAN provides signal data, profiler provides SSIDs
let cwlan = corewlanScan()
let profiler = profilerScan()

// Build lookup from profiler by channel+band for SSID matching
var profilerMap: [String: [String: Any]] = [:]
for p in profiler {
    let ch = p["channel"] as? Int ?? 0
    let band = p["band"] as? Int ?? 0
    let ssid = p["ssid"] as? String ?? ""
    if !ssid.isEmpty {
        profilerMap["\(ch)-\(band)-\(ssid)"] = p
        // Also index by just channel+band for matching hidden CWLANs
        let key = "\(ch)-\(band)"
        if profilerMap[key] == nil { profilerMap[key] = p }
    }
}

// Merge: enrich CoreWLAN entries with profiler SSIDs where hidden
var merged: [[String: Any]] = []
var usedProfilerSSIDs = Set<String>()

for var entry in cwlan {
    let ssid = entry["ssid"] as? String ?? ""
    let ch = entry["channel"] as? Int ?? 0
    let band = entry["band"] as? Int ?? 0

    if ssid.isEmpty {
        // Try to match by channel+band from profiler
        let key = "\(ch)-\(band)"
        if let match = profilerMap[key] {
            let matchSSID = match["ssid"] as? String ?? ""
            if !matchSSID.isEmpty && !usedProfilerSSIDs.contains("\(matchSSID)-\(ch)-\(band)") {
                entry["ssid"] = matchSSID
                usedProfilerSSIDs.insert("\(matchSSID)-\(ch)-\(band)")
            }
        }
    } else {
        usedProfilerSSIDs.insert("\(ssid)-\(ch)-\(band)")
    }
    merged.append(entry)
}

// Add any profiler-only networks not in CoreWLAN
for p in profiler {
    let ssid = p["ssid"] as? String ?? ""
    let ch = p["channel"] as? Int ?? 0
    let band = p["band"] as? Int ?? 0
    let key = "\(ssid)-\(ch)-\(band)"
    if !usedProfilerSSIDs.contains(key) {
        merged.append(p)
        usedProfilerSSIDs.insert(key)
    }
}

do {
    let json = try JSONSerialization.data(withJSONObject: merged, options: [.sortedKeys])
    print(String(data: json, encoding: .utf8)!)
} catch {
    print("[]")
}
