use k8s_openapi::apimachinery::pkg::apis::meta::v1::{MicroTime, Time};

pub fn rfc3339(time: &Time) -> String {
    time.0.to_string()
}

pub fn micro_rfc3339(time: &MicroTime) -> String {
    time.0.to_string()
}

pub fn millis(time: &Time) -> i64 {
    time.0.as_millisecond()
}

pub fn age_seconds(time: Option<&Time>) -> i64 {
    time.map(|t| ((chrono::Utc::now().timestamp_millis() - millis(t)) / 1000).max(0))
        .unwrap_or(0)
}
