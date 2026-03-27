import { describe, expect, test } from "bun:test"
import { importCursorSessionFromCurl } from "./cursor-cookies"

describe("cursor cookies", () => {
  test("imports Cursor cookies from a copied curl command", () => {
    const imported = importCursorSessionFromCurl(`curl 'https://cursor.com/api/dashboard/get-current-period-usage' -H 'accept: */*' -b 'workos_id=user_123; WorkosCursorSessionToken=session_abc; cursor_anonymous_id=anon_1' --data-raw '{}'`)

    expect(imported?.cookies.find((cookie) => cookie.name === "WorkosCursorSessionToken")?.value).toBe("session_abc")
    expect(imported?.cookies.find((cookie) => cookie.name === "workos_id")?.value).toBe("user_123")
  })
})
