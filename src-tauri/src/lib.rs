// iNote — 블록 노트 앱 저장 계층.
// 페이지는 개별 JSON 파일(블록 배열), 트리는 tree.json 하나.
// 모든 쓰기는 "수정 시각(ms)"을 함께 기록해 나중에 LAN 동기화 병합의 기준이 된다.

use std::fs;
use std::path::PathBuf;

use tauri::Manager;

fn err(e: impl std::fmt::Display) -> String {
    format!("{e}")
}

/// 데이터 폴더 (<app_data_dir>/notes). 없으면 만든다.
fn notes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(err)?.join("notes");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// 페이지 id 검증 — 파일명으로 쓰므로 UUID 형식만 허용 (경로 탈출 방지)
fn check_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok { Ok(()) } else { Err("잘못된 페이지 id".into()) }
}

/// 트리(페이지 목록·계층·순서) 읽기. 없으면 "null".
#[tauri::command]
fn tree_load(app: tauri::AppHandle) -> Result<String, String> {
    let p = notes_dir(&app)?.join("tree.json");
    match fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("null".into()),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
fn tree_save(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let dir = notes_dir(&app)?;
    // 임시 파일에 쓰고 교체 — 저장 중 강제 종료돼도 파일이 깨지지 않게
    let tmp = dir.join("tree.json.tmp");
    fs::write(&tmp, &json).map_err(err)?;
    fs::rename(&tmp, dir.join("tree.json")).map_err(err)
}

/// 페이지(블록 문서) 읽기. 없으면 "null".
#[tauri::command]
fn page_load(app: tauri::AppHandle, id: String) -> Result<String, String> {
    check_id(&id)?;
    let p = notes_dir(&app)?.join(format!("{id}.json"));
    match fs::read_to_string(&p) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("null".into()),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
fn page_save(app: tauri::AppHandle, id: String, json: String) -> Result<(), String> {
    check_id(&id)?;
    let dir = notes_dir(&app)?;
    let tmp = dir.join(format!("{id}.json.tmp"));
    fs::write(&tmp, &json).map_err(err)?;
    fs::rename(&tmp, dir.join(format!("{id}.json"))).map_err(err)
}

#[tauri::command]
fn page_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    check_id(&id)?;
    let p = notes_dir(&app)?.join(format!("{id}.json"));
    match fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(e)),
    }
}

/// 커버 이미지 — 선택한 이미지를 앱 데이터(notes/covers)로 복사하고 저장 경로를 돌려준다.
/// 원본 파일이 나중에 지워져도 커버가 깨지지 않도록 복사본을 쓴다.
#[tauri::command]
fn cover_set_image(app: tauri::AppHandle, id: String, src: String) -> Result<String, String> {
    check_id(&id)?;
    let ext = std::path::Path::new(&src)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp") {
        return Err("지원하지 않는 이미지 형식입니다".into());
    }
    let dir = notes_dir(&app)?.join("covers");
    fs::create_dir_all(&dir).map_err(err)?;
    // 이전 커버 정리 (확장자가 바뀌어도 남지 않게)
    for old in ["jpg", "jpeg", "png", "webp", "gif", "bmp"] {
        let _ = fs::remove_file(dir.join(format!("{id}.{old}")));
    }
    let dest = dir.join(format!("{id}.{ext}"));
    fs::copy(&src, &dest).map_err(err)?;
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            tree_load,
            tree_save,
            page_load,
            page_save,
            page_delete,
            cover_set_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
