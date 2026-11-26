// PDF の品質を数えるための小さな道具（PDFKit）。pdf-quality.mjs から呼ぶ。
// 使い方: swift scripts/dev/pdf-quality.swift <PDF> [<PDF> ...]
// 標準出力に JSON の配列を書く（1ファイル1要素）。
import Foundation
import PDFKit

struct OutlineItem: Codable {
    let title: String
    let page: Int
    let depth: Int
}

struct NoteItem: Codable {
    let page: Int
    let contents: String
}

struct LinkItem: Codable {
    let page: Int
    let url: String?
    let target: Int?
}

struct Result: Codable {
    let path: String
    let pages: Int
    let title: String?
    let width: Double?
    let height: Double?
    let outline: [OutlineItem]
    let notes: [NoteItem]
    let links: [LinkItem]
}

func inspect(_ path: String) -> Result? {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { return nil }
    var outline: [OutlineItem] = []
    func walk(_ node: PDFOutline?, _ depth: Int) {
        guard let node else { return }
        for i in 0..<node.numberOfChildren {
            guard let child = node.child(at: i) else { continue }
            let label = (child.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            var page = 0
            if let pg = child.destination?.page { page = doc.index(for: pg) + 1 }
            outline.append(OutlineItem(title: label, page: page, depth: depth))
            walk(child, depth + 1)
        }
    }
    walk(doc.outlineRoot, 0)

    var notes: [NoteItem] = []
    var links: [LinkItem] = []
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        for a in page.annotations {
            let type = a.type ?? ""
            if type == "Text" || a.contents != nil && type != "Link" {
                if let c = a.contents, !c.isEmpty {
                    notes.append(NoteItem(page: i + 1, contents: c))
                }
            }
            if type == "Link" || a.url != nil {
                var target: Int? = nil
                if let pg = a.destination?.page { target = doc.index(for: pg) + 1 }
                links.append(LinkItem(page: i + 1, url: a.url?.absoluteString, target: target))
            }
        }
    }
    let box = doc.page(at: 0)?.bounds(for: .mediaBox)
    return Result(
        path: path,
        pages: doc.pageCount,
        title: doc.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String,
        width: box.map { Double($0.width) },
        height: box.map { Double($0.height) },
        outline: outline,
        notes: notes,
        links: links
    )
}

var all: [Result] = []
for path in CommandLine.arguments.dropFirst() {
    if let r = inspect(path) {
        all.append(r)
    } else {
        FileHandle.standardError.write("開けません: \(path)\n".data(using: .utf8)!)
    }
}
let enc = JSONEncoder()
enc.outputFormatting = [.sortedKeys]
if let data = try? enc.encode(all), let text = String(data: data, encoding: .utf8) {
    print(text)
} else {
    exit(1)
}
