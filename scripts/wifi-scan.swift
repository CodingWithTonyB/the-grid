import Foundation
import CoreWLAN

let client = CWWiFiClient.shared()
guard let iface = client.interface() else {
    print("[]")
    exit(0)
}

do {
    let networks = try iface.scanForNetworks(withSSID: nil)
    var results: [[String: Any]] = []
    for net in networks {
        var entry: [String: Any] = [:]
        entry["ssid"] = net.ssid ?? ""
        entry["bssid"] = net.bssid ?? ""
        entry["rssi"] = net.rssiValue
        entry["channel"] = net.wlanChannel?.channelNumber ?? 0
        // band: 1=2.4GHz, 2=5GHz, 3=6GHz
        entry["band"] = net.wlanChannel?.channelBand.rawValue ?? 0
        entry["channelWidth"] = net.wlanChannel?.channelWidth.rawValue ?? 0
        entry["noise"] = net.noiseMeasurement
        entry["ibss"] = net.ibss
        entry["countryCode"] = net.countryCode ?? ""
        entry["beaconInterval"] = net.beaconInterval

        // Determine security level (pick highest)
        var sec = "Unknown"
        var secLevel = 0  // 0=unknown, 1=open, 2=wep, 3=wpa, 4=wpa2, 5=wpa3, 6=enterprise
        if net.supportsSecurity(.none) { sec = "Open"; secLevel = 1 }
        if net.supportsSecurity(.WEP) { sec = "WEP"; secLevel = 2 }
        if net.supportsSecurity(.wpaPersonal) { sec = "WPA"; secLevel = 3 }
        if net.supportsSecurity(.wpa2Personal) { sec = "WPA2"; secLevel = 4 }
        if net.supportsSecurity(.wpa3Personal) { sec = "WPA3"; secLevel = 5 }
        if net.supportsSecurity(.wpaEnterprise) { sec = "WPA Enterprise"; secLevel = 6 }
        if net.supportsSecurity(.wpa2Enterprise) { sec = "WPA2 Enterprise"; secLevel = 6 }
        if net.supportsSecurity(.wpa3Enterprise) { sec = "WPA3 Enterprise"; secLevel = 6 }
        entry["security"] = sec
        entry["securityLevel"] = secLevel

        results.append(entry)
    }
    let json = try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
    print(String(data: json, encoding: .utf8)!)
} catch {
    print("[]")
}
