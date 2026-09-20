import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// 前のテストが残した DOM を次へ持ち込まない。
afterEach(cleanup);
