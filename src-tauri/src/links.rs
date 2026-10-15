use crate::model::{Link, Note};

// A small scanner, intentionally excluding code spans and fenced code blocks.
pub fn targets(markdown: &str) -> Vec<(String, usize, usize, bool)> {
    let mut found = Vec::new();
    let mut offset = 0;
    let mut fenced = false;
    for line in markdown.split_inclusive('\n') {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fenced = !fenced;
            offset += line.len();
            continue;
        }
        if !fenced {
            let bytes = line.as_bytes();
            let mut i = 0;
            let mut code = false;
            while i < bytes.len() {
                if bytes[i] == b'`' {
                    code = !code;
                    i += 1;
                    continue;
                }
                if !code && line[i..].starts_with("[[") {
                    if let Some(end) = line[i + 2..].find("]]") {
                        let text = &line[i + 2..i + 2 + end];
                        let target = text
                            .split('|')
                            .next()
                            .unwrap_or(text)
                            .split('#')
                            .next()
                            .unwrap_or(text);
                        found.push((
                            target.to_string(),
                            offset + i + 2,
                            offset + i + 2 + target.len(),
                            true,
                        ));
                        i += end + 4;
                        continue;
                    }
                }
                if !code && line[i..].starts_with("](") && (i == 0 || bytes[i - 1] != b'\\') {
                    if let Some(end) = line[i + 2..].find(')') {
                        let target = &line[i + 2..i + 2 + end];
                        let target = target.split('#').next().unwrap_or(target);
                        if !target.contains("://")
                            && !target.starts_with("mailto:")
                            && !target.is_empty()
                        {
                            found.push((
                                target.to_string(),
                                offset + i + 2,
                                offset + i + 2 + target.len(),
                                false,
                            ));
                        }
                        i += end + 3;
                        continue;
                    }
                }
                // Advance on UTF-8 boundaries, never slicing through a character.
                i += line[i..].chars().next().map_or(1, char::len_utf8);
            }
        }
        offset += line.len();
    }
    found
}

pub fn normalize_relative(source: &str, target: &str) -> Option<String> {
    let mut parts: Vec<&str> = source.split('/').collect();
    parts.pop();
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

pub fn resolve(source: &str, target: &str, wiki: bool, notes: &[Note]) -> Link {
    let decoded = percent_decode(target);
    let mut matches = Vec::new();
    let relative = normalize_relative(source, &decoded);
    let direct = decoded.trim_start_matches('/');
    for note in notes {
        let without_ext = note.path.strip_suffix(".md").unwrap_or(&note.path);
        let relative_match = relative
            .as_ref()
            .is_some_and(|p| &note.path == p || (wiki && without_ext == p));
        let wiki_match = wiki
            && (note.path == direct
                || without_ext == direct
                || (!decoded.contains('/')
                    && (note.title == decoded
                        || std::path::Path::new(without_ext)
                            .file_name()
                            .and_then(|x| x.to_str())
                            == Some(decoded.as_str()))));
        if relative_match || wiki_match {
            matches.push(note.id.clone());
        }
    }
    matches.sort();
    matches.dedup();
    Link {
        target: target.to_string(),
        resolved_id: if matches.len() == 1 {
            Some(matches[0].clone())
        } else {
            None
        },
        status: match matches.len() {
            0 => "broken",
            1 => "resolved",
            _ => "ambiguous",
        }
        .to_string(),
    }
}

pub fn relative_path(source: &str, destination: &str) -> String {
    let mut from: Vec<&str> = source.split('/').collect();
    from.pop();
    let to: Vec<&str> = destination.split('/').collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut result = vec![".."; from.len() - common];
    result.extend_from_slice(&to[common..]);
    result.join("/")
}

pub(crate) fn percent_decode(value: &str) -> String {
    let mut result = Vec::new();
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(n) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|s| u8::from_str_radix(s, 16).ok())
            {
                result.push(n);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| value.to_string())
}
