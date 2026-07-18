import { describe, expect, it } from "vitest";
import { extractImportedPackages } from "../src/import-detect.js";

describe("extractImportedPackages — JS/TS", () => {
  it("extracts a default import", () => {
    expect(extractImportedPackages('import Stripe from "stripe";', "a.ts")).toEqual(["stripe"]);
  });

  it("extracts a named import", () => {
    expect(extractImportedPackages('import { z } from "zod";', "a.ts")).toEqual(["zod"]);
  });

  it("extracts a multi-line named import", () => {
    const diff = 'import {\n  foo,\n  bar,\n} from "@org/pkg";\n';
    expect(extractImportedPackages(diff, "a.ts")).toEqual(["@org/pkg"]);
  });

  it("normalizes a subpath import to the top-level package", () => {
    expect(extractImportedPackages('import Webhooks from "stripe/webhooks";', "a.ts")).toEqual(["stripe"]);
  });

  it("normalizes a scoped package with a subpath to scope+package", () => {
    expect(extractImportedPackages('import x from "@radix-ui/react-dialog";', "a.ts")).toEqual([
      "@radix-ui/react-dialog",
    ]);
  });

  it("extracts a side-effect import with no `from`", () => {
    expect(extractImportedPackages('import "reflect-metadata";', "a.ts")).toEqual(["reflect-metadata"]);
  });

  it("extracts a bare export-from re-export", () => {
    expect(extractImportedPackages('export * from "some-pkg";', "a.ts")).toEqual(["some-pkg"]);
  });

  it("extracts require()", () => {
    expect(extractImportedPackages('const x = require("lodash");', "a.js")).toEqual(["lodash"]);
  });

  it("extracts dynamic import()", () => {
    expect(extractImportedPackages('const mod = await import("some-pkg");', "a.ts")).toEqual(["some-pkg"]);
  });

  it("does not match an import inside a // comment", () => {
    expect(extractImportedPackages('// import Stripe from "stripe";', "a.ts")).toEqual([]);
  });

  it("does not match a require() inside a // comment", () => {
    expect(extractImportedPackages('// const x = require("lodash");', "a.ts")).toEqual([]);
  });

  it("does not match import-shaped text embedded in a plain string literal", () => {
    expect(extractImportedPackages("const example = \"import Stripe from 'stripe';\";", "a.ts")).toEqual([]);
  });

  it("does not match require-shaped text embedded in a plain string literal", () => {
    expect(extractImportedPackages("const doc = \"call require('pkg') to load it\";", "a.ts")).toEqual([]);
  });

  it("does not match a package name mentioned inside a URL", () => {
    expect(extractImportedPackages('// see https://npmjs.com/package/stripe for docs', "a.ts")).toEqual([]);
  });

  it("never scans a markdown file, even if it contains real-looking import syntax", () => {
    expect(extractImportedPackages('import Stripe from "stripe";', "README.md")).toEqual([]);
  });

  it("returns [] for an unrecognized file extension", () => {
    expect(extractImportedPackages('import Stripe from "stripe";', "a.unknown")).toEqual([]);
  });
});

describe("extractImportedPackages — Python", () => {
  it("extracts a plain import", () => {
    expect(extractImportedPackages("import pandas", "a.py")).toEqual(["pandas"]);
  });

  it("extracts import with alias", () => {
    expect(extractImportedPackages("import pandas as pd", "a.py")).toEqual(["pandas"]);
  });

  it("extracts multiple comma-separated imports", () => {
    expect(extractImportedPackages("import os, pandas as pd, sys", "a.py")).toEqual(["os", "pandas", "sys"]);
  });

  it("extracts from-import and normalizes a submodule", () => {
    expect(extractImportedPackages("from fastapi import FastAPI", "a.py")).toEqual(["fastapi"]);
    expect(extractImportedPackages("from django.db import models", "a.py")).toEqual(["django"]);
  });

  it("does not match a # comment", () => {
    expect(extractImportedPackages("# import pandas as pd", "a.py")).toEqual([]);
  });

  it("does not match import-shaped text inside a string literal", () => {
    expect(extractImportedPackages('doc = "import pandas as pd"', "a.py")).toEqual([]);
  });
});

describe("extractImportedPackages — Go", () => {
  it("extracts a single-line import and strips a version suffix", () => {
    expect(extractImportedPackages('import "github.com/redis/go-redis/v9"', "main.go")).toEqual([
      "github.com/redis/go-redis",
    ]);
  });

  it("extracts every path inside an import block", () => {
    const diff = 'import (\n\t"fmt"\n\t"github.com/gin-gonic/gin"\n)';
    expect(extractImportedPackages(diff, "main.go")).toEqual(["fmt", "github.com/gin-gonic/gin"]);
  });

  it("does not match a // comment", () => {
    expect(extractImportedPackages('// import "fmt"', "main.go")).toEqual([]);
  });
});

describe("extractImportedPackages — Ruby", () => {
  it("extracts require and normalizes a subpath", () => {
    expect(extractImportedPackages('require "sidekiq/api"', "app.rb")).toEqual(["sidekiq"]);
  });

  it("does not extract require_relative (local file, not a package)", () => {
    expect(extractImportedPackages('require_relative "../lib/foo"', "app.rb")).toEqual([]);
  });

  it("extracts gem declarations from a Gemfile", () => {
    expect(extractImportedPackages('gem "devise"\ngem "sidekiq", "~> 7.0"', "Gemfile")).toEqual([
      "devise",
      "sidekiq",
    ]);
  });

  it("does not match a # comment", () => {
    expect(extractImportedPackages('# require "sidekiq"', "app.rb")).toEqual([]);
  });
});

describe("extractImportedPackages — PHP", () => {
  it("extracts the first namespace segment from a use statement", () => {
    expect(extractImportedPackages("use Illuminate\\Http\\Request;", "app/Foo.php")).toEqual(["illuminate"]);
  });

  it("parses composer.json's require block", () => {
    const diff = JSON.stringify({ require: { php: "^8.1", "laravel/framework": "^10.0" } });
    expect(extractImportedPackages(diff, "composer.json")).toEqual(["laravel/framework"]);
  });

  it("does not match a // comment", () => {
    expect(extractImportedPackages("// use Illuminate\\Http\\Request;", "app/Foo.php")).toEqual([]);
  });
});

describe("extractImportedPackages — Rust", () => {
  it("extracts a use statement's first path segment", () => {
    expect(extractImportedPackages("use tokio::net::TcpListener;", "src/main.rs")).toEqual(["tokio"]);
  });

  it("extracts a grouped use statement's first segment only once", () => {
    const diff = "use tokio::{net::TcpListener, sync::Mutex};";
    expect(extractImportedPackages(diff, "src/main.rs")).toEqual(["tokio"]);
  });

  it("extracts a pub use re-export", () => {
    expect(extractImportedPackages("pub use serde::Serialize;", "src/lib.rs")).toEqual(["serde"]);
    expect(extractImportedPackages("pub(crate) use clap::Parser;", "src/lib.rs")).toEqual(["clap"]);
  });

  it("does not extract local/std roots (crate, self, super, std, core, alloc)", () => {
    expect(extractImportedPackages("use crate::config::Settings;", "src/main.rs")).toEqual([]);
    expect(extractImportedPackages("use super::helpers::run;", "src/main.rs")).toEqual([]);
    expect(extractImportedPackages("use std::collections::HashMap;", "src/main.rs")).toEqual([]);
  });

  it("normalizes a hyphenated crate name to its use-statement underscore form", () => {
    expect(extractImportedPackages("use actix_web::web;", "src/main.rs")).toEqual(["actix_web"]);
  });

  it("does not match a // comment", () => {
    expect(extractImportedPackages("// use tokio::main;", "src/main.rs")).toEqual([]);
  });

  it("does not match use-shaped text inside a string literal", () => {
    expect(extractImportedPackages('let s = "use tokio::main;";', "src/main.rs")).toEqual([]);
  });

  it("never scans a markdown file even with real-looking use syntax", () => {
    expect(extractImportedPackages("use tokio::main;", "README.md")).toEqual([]);
  });

  it("parses a Cargo.toml [dependencies] block, ignoring [package] metadata", () => {
    const diff = [
      "[package]",
      'name = "myapp"',
      'version = "0.1.0"',
      'edition = "2021"',
      "",
      "[dependencies]",
      'tokio = { version = "1", features = ["full"] }',
      'serde = "1.0"',
    ].join("\n");
    expect(extractImportedPackages(diff, "Cargo.toml")).toEqual(["tokio", "serde"]);
  });

  it("parses a dotted Cargo.toml dependency section header without key-scanning its body", () => {
    const diff = ['[dependencies.tokio]', 'version = "1"', 'features = ["full"]'].join("\n");
    // Only "tokio" (from the header) — never "version"/"features" (the
    // body keys, which are Cargo.toml keys, not crate names).
    expect(extractImportedPackages(diff, "Cargo.toml")).toEqual(["tokio"]);
  });

  it("normalizes a hyphenated Cargo.toml dependency name to underscore form, matching its use-statement form", () => {
    const diff = ["[dependencies]", 'actix-web = "4"'].join("\n");
    expect(extractImportedPackages(diff, "Cargo.toml")).toEqual(["actix_web"]);
  });

  it("does not treat a dev-dependencies/build-dependencies body as [package] metadata", () => {
    const diff = ["[dev-dependencies]", 'criterion = "0.5"'].join("\n");
    expect(extractImportedPackages(diff, "Cargo.toml")).toEqual(["criterion"]);
  });

  it("does not match a commented-out Cargo.toml dependency line", () => {
    const diff = ["[dependencies]", '# tokio = "1"'].join("\n");
    expect(extractImportedPackages(diff, "Cargo.toml")).toEqual([]);
  });

  it("stops key-scanning once a later, unrelated section starts", () => {
    const diff = ["[dependencies]", 'tokio = "1"', "", "[profile.release]", 'opt-level = "3"'].join("\n");
    expect(extractImportedPackages(diff, "Cargo.toml")).toEqual(["tokio"]);
  });
});

describe("extractImportedPackages — Java / Kotlin", () => {
  it("extracts a Java import, normalized to its 2-segment root", () => {
    expect(extractImportedPackages("import org.springframework.boot.SpringApplication;", "App.java")).toContain(
      "org.springframework"
    );
  });

  it("emits both 2- and 3-segment candidates so a generic 2-segment root doesn't collide across unrelated libraries", () => {
    const candidates = extractImportedPackages("import com.google.gson.Gson;", "App.java");
    expect(candidates).toContain("com.google.gson");
    // "com.google" alone is deliberately never a package-map key (see
    // import-detect.ts's dottedPathPrefixes comment) — it's still emitted
    // as a harmless candidate that simply won't be found in the map.
    expect(candidates).toContain("com.google");
  });

  it("extracts a single-segment root (retrofit2) without appending the class name", () => {
    expect(extractImportedPackages("import retrofit2.Retrofit;", "Api.java")).toContain("retrofit2");
  });

  it("extracts a static import", () => {
    expect(extractImportedPackages("import static org.junit.Assert.assertEquals;", "Test.java")).toContain(
      "org.junit"
    );
  });

  it("extracts a Kotlin import without a trailing semicolon, and an aliased import", () => {
    expect(extractImportedPackages("import org.junit.jupiter.api.Test", "Test.kt")).toContain("org.junit");
    expect(extractImportedPackages("import kotlin.io.println as p", "Main.kt")).toContain("kotlin.io");
  });

  it("does not match a // comment", () => {
    expect(extractImportedPackages("// import org.springframework.boot.SpringApplication;", "App.java")).toEqual(
      []
    );
  });

  it("does not match import-shaped text inside a string literal", () => {
    expect(
      extractImportedPackages('String s = "import org.springframework.boot.SpringApplication;";', "App.java")
    ).toEqual([]);
  });

  it("never scans a markdown file even with real-looking import syntax", () => {
    expect(extractImportedPackages("import org.springframework.boot.SpringApplication;", "README.md")).toEqual([]);
  });
});

describe("extractImportedPackages — C#", () => {
  it("extracts a using directive, normalized to its 2-segment root", () => {
    expect(extractImportedPackages("using Microsoft.AspNetCore.Mvc;", "Program.cs")).toContain(
      "microsoft.aspnetcore"
    );
  });

  it("extracts a full 2-segment namespace unchanged", () => {
    expect(extractImportedPackages("using Newtonsoft.Json;", "Program.cs")).toContain("newtonsoft.json");
  });

  it("extracts a single-segment root (Xunit)", () => {
    expect(extractImportedPackages("using Xunit;", "Tests.cs")).toContain("xunit");
  });

  it("extracts System.* at 3 segments so it isn't collapsed to the too-generic 'system.text'", () => {
    const candidates = extractImportedPackages("using System.Text.Json;", "Program.cs");
    expect(candidates).toContain("system.text.json");
  });

  it("extracts a global using and a static using", () => {
    expect(extractImportedPackages("global using System.Text.Json;", "GlobalUsings.cs")).toContain(
      "system.text.json"
    );
    expect(extractImportedPackages("using static System.Console;", "Program.cs")).toContain("system.console");
  });

  it("extracts a using with an alias", () => {
    expect(extractImportedPackages("using Json = Newtonsoft.Json;", "Program.cs")).toContain("newtonsoft.json");
  });

  it("does not match a // comment", () => {
    expect(extractImportedPackages("// using Newtonsoft.Json;", "Program.cs")).toEqual([]);
  });

  it("does not match using-shaped text inside a string literal", () => {
    expect(extractImportedPackages('var s = "using Newtonsoft.Json;";', "Program.cs")).toEqual([]);
  });

  it("extracts a PackageReference from a .csproj file", () => {
    const diff = '<PackageReference Include="Newtonsoft.Json" Version="13.0.1" />';
    expect(extractImportedPackages(diff, "MyApp.csproj")).toEqual(["newtonsoft.json"]);
  });

  it("does not match a PackageReference inside an XML comment", () => {
    const diff = '<!-- <PackageReference Include="Newtonsoft.Json" Version="13.0.1" /> -->';
    expect(extractImportedPackages(diff, "MyApp.csproj")).toEqual([]);
  });

  it("does not match a PackageReference inside a multi-line XML comment", () => {
    const diff = ["<!--", '<PackageReference Include="Newtonsoft.Json" Version="13.0.1" />', "-->"].join("\n");
    expect(extractImportedPackages(diff, "MyApp.csproj")).toEqual([]);
  });

  it("never scans a markdown file even with real-looking using syntax", () => {
    expect(extractImportedPackages("using Newtonsoft.Json;", "README.md")).toEqual([]);
  });
});

describe("extractImportedPackages — Swift", () => {
  it("extracts a plain import", () => {
    expect(extractImportedPackages("import Alamofire", "Client.swift")).toEqual(["alamofire"]);
  });

  it("extracts a @testable import", () => {
    expect(extractImportedPackages("@testable import MyApp", "MyAppTests.swift")).toEqual(["myapp"]);
  });

  it("extracts a submodule import, naming the module rather than the kind keyword", () => {
    expect(extractImportedPackages("import struct Foundation.Date", "Model.swift")).toEqual(["foundation"]);
    expect(extractImportedPackages("import class UIKit.UIView", "View.swift")).toEqual(["uikit"]);
  });

  it("does not match a // comment", () => {
    expect(extractImportedPackages("// import Alamofire", "Client.swift")).toEqual([]);
  });

  it("does not match import-shaped text inside a string literal", () => {
    expect(extractImportedPackages('let s = "import Alamofire"', "Client.swift")).toEqual([]);
  });

  it("never scans a markdown file even with real-looking import syntax", () => {
    expect(extractImportedPackages("import Alamofire", "README.md")).toEqual([]);
  });

  it("extracts a Package.swift dependency URL, normalized to its last path segment", () => {
    const diff = '.package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.0.0"),';
    expect(extractImportedPackages(diff, "Package.swift")).toEqual(["alamofire"]);
  });

  it("extracts a Package.swift dependency using the older explicit name: form", () => {
    const diff = '.package(name: "Alamofire", url: "https://github.com/Alamofire/Alamofire.git", from: "5.0.0"),';
    expect(extractImportedPackages(diff, "Package.swift")).toEqual(["alamofire"]);
  });

  it("does not match a commented-out Package.swift dependency", () => {
    const diff = '// .package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.0.0"),';
    expect(extractImportedPackages(diff, "Package.swift")).toEqual([]);
  });

  it("strips a literal .swift repo-name suffix so it matches the module's own import name (GRDB.swift -> grdb)", () => {
    const diff = '.package(url: "https://github.com/groue/GRDB.swift.git", from: "6.0.0"),';
    expect(extractImportedPackages(diff, "Package.swift")).toEqual(["grdb"]);
    expect(extractImportedPackages("import GRDB", "Database.swift")).toEqual(["grdb"]);
  });

  it("does not strip a name that merely ENDS in 'swift' without a preceding dot (RxSwift)", () => {
    const diff = '.package(url: "https://github.com/ReactiveX/RxSwift.git", from: "6.0.0"),';
    expect(extractImportedPackages(diff, "Package.swift")).toEqual(["rxswift"]);
  });
});

describe("extractImportedPackages — MCP SDKs (ai/mcp package-map keys)", () => {
  it("extracts the official TypeScript MCP SDK import", () => {
    expect(extractImportedPackages('import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";', "server.ts")).toEqual([
      "@modelcontextprotocol/sdk",
    ]);
  });

  it("extracts the official Python MCP SDK import", () => {
    expect(extractImportedPackages("from mcp.server.fastmcp import FastMCP", "server.py")).toEqual(["mcp"]);
    expect(extractImportedPackages("import fastmcp", "server.py")).toEqual(["fastmcp"]);
  });

  it("extracts the official Rust MCP SDK crate", () => {
    expect(extractImportedPackages("use rmcp::ServerHandler;", "main.rs")).toEqual(["rmcp"]);
    expect(extractImportedPackages("[dependencies]\nrmcp = \"0.1\"", "Cargo.toml")).toEqual(["rmcp"]);
  });

  it("extracts the official Java MCP SDK import root", () => {
    expect(
      extractImportedPackages("import io.modelcontextprotocol.client.McpClient;", "App.java")
    ).toContain("io.modelcontextprotocol");
  });

  it("extracts the official Go MCP SDK import path", () => {
    expect(
      extractImportedPackages('import "github.com/modelcontextprotocol/go-sdk/mcp"', "main.go")
    ).toEqual(["github.com/modelcontextprotocol/go-sdk/mcp"]);
  });

  it("extracts the official C# MCP SDK using and PackageReference forms", () => {
    expect(extractImportedPackages("using ModelContextProtocol.Client;", "Program.cs")).toContain("modelcontextprotocol");
    expect(
      extractImportedPackages('<PackageReference Include="ModelContextProtocol" Version="1.0.0" />', "App.csproj")
    ).toEqual(["modelcontextprotocol"]);
  });
});
