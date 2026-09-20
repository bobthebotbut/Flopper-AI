// ai_chatbot.js - Flopper AI
// Setup: copy dictionary.txt and wiki.txt to /ext/apps_data/ai_chatbot/ on the SD card.

let eventLoop = require("event_loop");
let gui = require("gui");
let submenuView = require("gui/submenu");
let dialogView = require("gui/dialog");
let textInputView = require("gui/text_input");
let textBoxView = require("gui/text_box");
let storage = require("storage");
let flipper = require("flipper");

let LEARNED_DIR = "/ext/apps_data/ai_chatbot";
let LEARNED_PATH = "/ext/apps_data/ai_chatbot/learned.txt";
let DICTIONARY_PATH = "/ext/apps_data/ai_chatbot/dictionary.txt";
let WIKI_PATH = "/ext/apps_data/ai_chatbot/wiki.txt";
let SETTINGS_PATH = "/ext/apps_data/ai_chatbot/settings.txt";
let READ_CHUNK = 200;

let learnedDefs = [];
let learnedWiki = [];
let userName = "";

function makeSubmenu(header, itemLabels) {
    let sm = submenuView.makeWith({ header: header });
    for (let i = 0; i < itemLabels.length; i++) {
        sm.addChild(itemLabels[i]);
    }
    return sm;
}

function trimStr(s) {
    let start = 0;
    while (start < s.length && s.charCodeAt(start) === 32) {
        start = start + 1;
    }
    let end = s.length;
    while (end > start && s.charCodeAt(end - 1) === 32) {
        end = end - 1;
    }
    return s.slice(start, end);
}

function replaceUnderscoresWithSpaces(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        out += (c === 95) ? " " : s.slice(i, i + 1);
    }
    return out;
}

function findFrom(s, needle, fromIdx) {
    let rem = s.slice(fromIdx);
    let idx = rem.indexOf(needle);
    return idx === -1 ? -1 : fromIdx + idx;
}

function skipSpaces(s, i) {
    while (i < s.length && s.charCodeAt(i) === 32) {
        i = i + 1;
    }
    return i;
}

function parseNumberFromString(numStr) {
    let dotIdx = numStr.indexOf(".");
    if (dotIdx === -1) {
        return parseInt(numStr, 10);
    }
    let intPart = numStr.slice(0, dotIdx);
    let fracPart = numStr.slice(dotIdx + 1);
    let intVal = intPart.length > 0 ? parseInt(intPart, 10) : 0;
    let fracVal = 0;
    if (fracPart.length > 0) {
        let fracInt = parseInt(fracPart, 10);
        let divisor = 1;
        for (let k = 0; k < fracPart.length; k++) {
            divisor = divisor * 10;
        }
        fracVal = fracInt / divisor;
    }
    return intVal + fracVal;
}

function parseNumber(s, i) {
    let start = i;
    while (i < s.length) {
        let c = s.charCodeAt(i);
        if ((c >= 48 && c <= 57) || c === 46) {
            i = i + 1;
        } else {
            break;
        }
    }
    return [parseNumberFromString(s.slice(start, i)), i];
}

function parseFactor(s, i) {
    i = skipSpaces(s, i);
    let c = s.charCodeAt(i);
    if (c === 45) {
        let r = parseFactor(s, i + 1);
        return [-r[0], r[1]];
    }
    if (c === 40) {
        let r = parseExpr(s, i + 1);
        let j = skipSpaces(s, r[1]);
        if (s.charCodeAt(j) === 41) {
            j = j + 1;
        }
        return [r[0], j];
    }
    return parseNumber(s, i);
}

function parseTerm(s, i) {
    let r = parseFactor(s, i);
    let value = r[0];
    let j = r[1];
    while (true) {
        j = skipSpaces(s, j);
        let c = j < s.length ? s.charCodeAt(j) : -1;
        if (c === 42) {
            let r2 = parseFactor(s, j + 1);
            value = value * r2[0];
            j = r2[1];
        } else if (c === 47) {
            let r2 = parseFactor(s, j + 1);
            value = value / r2[0];
            j = r2[1];
        } else {
            break;
        }
    }
    return [value, j];
}

function parseExpr(s, i) {
    let r = parseTerm(s, i);
    let value = r[0];
    let j = r[1];
    while (true) {
        j = skipSpaces(s, j);
        let c = j < s.length ? s.charCodeAt(j) : -1;
        if (c === 43) {
            let r2 = parseTerm(s, j + 1);
            value = value + r2[0];
            j = r2[1];
        } else if (c === 45) {
            let r2 = parseTerm(s, j + 1);
            value = value - r2[0];
            j = r2[1];
        } else {
            break;
        }
    }
    return [value, j];
}

function evalMath(expr) {
    return parseExpr(expr, 0)[0];
}

function isMathExpression(s) {
    if (s.length === 0) {
        return false;
    }
    let sawDigit = false;
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        let isDigit = (c >= 48 && c <= 57);
        let ok = isDigit || c === 32 || c === 46 || c === 43 || c === 45 || c === 42 || c === 47 || c === 40 || c === 41;
        if (!ok) {
            return false;
        }
        if (isDigit) {
            sawDigit = true;
        }
    }
    return sawDigit;
}

// shared streaming scanner: calls onLine(line) for each line in `path`,
// reading a small fixed chunk at a time so memory doesn't grow with file
// size. onLine returning true stops the scan early.
function scanFile(path, onLine) {
    if (!storage.fileExists(path)) {
        return;
    }
    let file = storage.openFile(path, "r", "open_existing");
    let carry = "";
    let counter = 0;
    let limit = 5000;
    while (true) {
        counter = counter + 1;
        if (counter > limit) {
            break;
        }
        let chunk = file.read("ascii", READ_CHUNK);
        let got = (chunk !== undefined && chunk !== null && chunk.length > 0);
        let data = got ? (carry + chunk) : carry;
        let pos = 0;
        let stop = false;
        while (true) {
            let nl = findFrom(data, "\n", pos);
            if (nl === -1) {
                break;
            }
            let line = data.slice(pos, nl);
            pos = nl + 1;
            if (line.length > 0 && onLine(line) === true) {
                stop = true;
                break;
            }
        }
        carry = data.slice(pos);
        if (stop) {
            break;
        }
        if (!got) {
            if (carry.length > 0) {
                onLine(carry);
            }
            break;
        }
    }
    file.close();
}

function findInFile(path, wantKey) {
    let result = undefined;
    scanFile(path, function (line) {
        let sep = findFrom(line, "::", 0);
        if (sep !== -1 && line.slice(0, sep) === wantKey) {
            result = line.slice(sep + 2);
            return true;
        }
        return false;
    });
    return result;
}

function collectKeysFromFile(path) {
    let keys = [];
    scanFile(path, function (line) {
        let sep = findFrom(line, "::", 0);
        if (sep !== -1) {
            keys.push(line.slice(0, sep));
        }
        return false;
    });
    return keys;
}

function ensureLearnedDir() {
    if (!storage.fileExists(LEARNED_DIR)) {
        storage.makeDirectory(LEARNED_DIR);
    }
}

function appendLearnedLine(line) {
    ensureLearnedDir();
    let file = storage.openFile(LEARNED_PATH, "w", "open_append");
    file.write(line);
    file.close();
}

function rewriteLearnedFile() {
    ensureLearnedDir();
    let file = storage.openFile(LEARNED_PATH, "w", "create_always");
    for (let i = 0; i < learnedDefs.length; i++) {
        file.write("define::" + learnedDefs[i][0] + "::" + learnedDefs[i][1] + "\n");
    }
    for (let i = 0; i < learnedWiki.length; i++) {
        file.write("wiki::" + learnedWiki[i][0] + "::" + learnedWiki[i][1] + "\n");
    }
    file.close();
}

function parseLearnedLine(line) {
    let sep1 = findFrom(line, "::", 0);
    if (sep1 === -1) {
        return;
    }
    let type = line.slice(0, sep1);
    let rest = line.slice(sep1 + 2);
    let sep2 = findFrom(rest, "::", 0);
    if (sep2 === -1) {
        return;
    }
    let key = rest.slice(0, sep2);
    let value = rest.slice(sep2 + 2);
    if (type === "define") {
        learnedDefs.push([key, value]);
    } else if (type === "wiki") {
        learnedWiki.push([key, value]);
    }
}

function loadLearnedFacts() {
    if (!storage.fileExists(LEARNED_PATH)) {
        return;
    }
    let file = storage.openFile(LEARNED_PATH, "r", "open_existing");
    let content = file.read("ascii", 4096);
    file.close();
    if (content === undefined || content === null || content.length === 0) {
        return;
    }
    let pos = 0;
    while (pos < content.length) {
        let nl = findFrom(content, "\n", pos);
        let line;
        if (nl === -1) {
            line = content.slice(pos);
            pos = content.length;
        } else {
            line = content.slice(pos, nl);
            pos = nl + 1;
        }
        if (line.length > 0) {
            parseLearnedLine(line);
        }
    }
}

function loadUserName() {
    if (!storage.fileExists(SETTINGS_PATH)) {
        return;
    }
    let file = storage.openFile(SETTINGS_PATH, "r", "open_existing");
    let content = file.read("ascii", 256);
    file.close();
    if (content === undefined || content === null) {
        return;
    }
    let nl = findFrom(content, "\n", 0);
    userName = trimStr(nl === -1 ? content : content.slice(0, nl));
}

function saveUserName(name) {
    userName = name;
    ensureLearnedDir();
    let file = storage.openFile(SETTINGS_PATH, "w", "create_always");
    file.write(name + "\n");
    file.close();
}

function removeFromArray(arr, matchKey) {
    let found = false;
    let survivors = [];
    for (let i = 0; i < arr.length; i++) {
        if (arr[i][0] === matchKey) {
            found = true;
        } else {
            survivors.push(arr[i]);
        }
    }
    while (arr.length > 0) {
        arr.pop();
    }
    for (let i = 0; i < survivors.length; i++) {
        arr.push(survivors[i]);
    }
    return found;
}

function lookupLearnedArray(arr, key) {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i][0] === key) {
            return arr[i][1];
        }
    }
    return undefined;
}

function lookupDefine(word) {
    let v = lookupLearnedArray(learnedDefs, word);
    return v !== undefined ? v : findInFile(DICTIONARY_PATH, word);
}

function lookupWiki(topic) {
    let v = lookupLearnedArray(learnedWiki, topic);
    return v !== undefined ? v : findInFile(WIKI_PATH, topic);
}

function buildWikiTopicList() {
    let topics = collectKeysFromFile(WIKI_PATH);
    for (let i = 0; i < learnedWiki.length; i++) {
        topics.push(learnedWiki[i][0]);
    }
    return topics;
}

function buildDictionaryWordList() {
    let words = collectKeysFromFile(DICTIONARY_PATH);
    for (let i = 0; i < learnedDefs.length; i++) {
        words.push(learnedDefs[i][0]);
    }
    return words;
}

let jokes = [
    "Why did the programmer quit his job? Because he didn't get arrays.",
    "Why do programmers prefer dark mode? Because light attracts bugs.",
    "There are 10 types of people: those who understand binary and those who don't.",
    "Why was the computer cold? It left its Windows open.",
];
let jokeIndex = 0;

function randomJoke() {
    let j = jokes[jokeIndex % jokes.length];
    jokeIndex = jokeIndex + 1;
    return j;
}

function listLearnedText() {
    let out = "Taught definitions (" + learnedDefs.length.toString() + "):\n";
    for (let i = 0; i < learnedDefs.length; i++) {
        out += "- " + learnedDefs[i][0] + "\n";
    }
    out += "\nTaught wiki topics (" + learnedWiki.length.toString() + "):\n";
    for (let i = 0; i < learnedWiki.length; i++) {
        out += "- " + learnedWiki[i][0] + "\n";
    }
    if (learnedDefs.length === 0 && learnedWiki.length === 0) {
        out += "(nothing taught yet)";
    }
    return out;
}

function creditsText() {
    return "Flopper AI\n\nCreated by bobthebotbut\ngithub.com/bobthebotbut\n\n(c) 2026 bobthebotbut.\nAll rights reserved.";
}

function helpText() {
    return "Commands:\ndefine <word>\nwiki <topic>\ncalc <expr> (or just type math)\nbattery\nstatus\njoke\nteach define <word> = <text>\nteach wiki <topic> = <text>\nforget define <word>\nforget wiki <topic>\nlearned\nhello, bye, thanks, how are you, and more\n\nMain menu has Dictionary/Wikipedia browsing and Options (set your name).\nUnderscores work as spaces, e.g. flipper_zero.\nFully offline, no internet access.";
}

function processQuery(text) {
    let lower = text.toLowerCase();

    if (lower.indexOf("teach define ") === 0) {
        let rest = text.slice(13);
        let eq = findFrom(rest, "=", 0);
        if (eq === -1) {
            return "Use: teach define <word> = <definition>";
        }
        let word = trimStr(rest.slice(0, eq)).toLowerCase();
        let def = trimStr(rest.slice(eq + 1));
        if (word.length === 0 || def.length === 0) {
            return "Use: teach define <word> = <definition>";
        }
        learnedDefs.push([word, def]);
        appendLearnedLine("define::" + word + "::" + def + "\n");
        return "Learned! '" + word + "' -> " + def;
    }

    if (lower.indexOf("teach wiki ") === 0) {
        let rest = text.slice(11);
        let eq = findFrom(rest, "=", 0);
        if (eq === -1) {
            return "Use: teach wiki <topic> = <summary>";
        }
        let topic = trimStr(rest.slice(0, eq)).toLowerCase();
        let summary = trimStr(rest.slice(eq + 1));
        if (topic.length === 0 || summary.length === 0) {
            return "Use: teach wiki <topic> = <summary>";
        }
        learnedWiki.push([topic, summary]);
        appendLearnedLine("wiki::" + topic + "::" + summary + "\n");
        return "Learned! Wiki entry for '" + topic + "' saved.";
    }

    if (lower.indexOf("teach") === 0) {
        return "Use:\nteach define <word> = <definition>\nteach wiki <topic> = <summary>";
    }

    if (lower.indexOf("forget define ") === 0) {
        let word = trimStr(text.slice(14)).toLowerCase();
        if (removeFromArray(learnedDefs, word)) {
            rewriteLearnedFile();
            return "Forgot the taught definition for '" + word + "'.";
        }
        return "No taught definition found for '" + word + "'.";
    }

    if (lower.indexOf("forget wiki ") === 0) {
        let topic = trimStr(text.slice(12)).toLowerCase();
        if (removeFromArray(learnedWiki, topic)) {
            rewriteLearnedFile();
            return "Forgot the taught wiki topic '" + topic + "'.";
        }
        return "No taught wiki topic found for '" + topic + "'.";
    }

    if (lower === "learned" || lower === "list learned" || lower === "list") {
        return listLearnedText();
    }

    if (lower === "status") {
        let dictOk = storage.fileExists(DICTIONARY_PATH);
        let wikiOk = storage.fileExists(WIKI_PATH);
        let learnedOk = storage.fileExists(LEARNED_PATH);
        return "File check:\ndictionary.txt: " + (dictOk ? "found" : "MISSING") +
            "\nwiki.txt: " + (wikiOk ? "found" : "MISSING") +
            "\nlearned.txt: " + (learnedOk ? "found" : "not created yet");
    }

    if (lower.indexOf("define ") === 0) {
        let word = text.slice(7).toLowerCase();
        let def = lookupDefine(word);
        if (def !== undefined) {
            return word + ":\n" + def;
        }
        return "No definition for '" + word + "'.\nTeach me with:\nteach define " + word + " = <definition>";
    }

    if (lower.indexOf("wiki ") === 0) {
        let topic = text.slice(5).toLowerCase();
        let info = lookupWiki(topic);
        if (info !== undefined) {
            return info;
        }
        return "No article for '" + topic + "'.\nTeach me with:\nteach wiki " + topic + " = <summary>";
    }

    if (lower.indexOf("calc ") === 0 || lower.indexOf("math ") === 0) {
        let expr = text.slice(5);
        if (isMathExpression(expr)) {
            return expr + " = " + evalMath(expr).toString();
        }
        return "That doesn't look like a math expression I can parse.";
    }

    if (lower === "battery") {
        return "Battery: " + flipper.getBatteryCharge().toString() + "%";
    }

    if (isMathExpression(text)) {
        return text + " = " + evalMath(text).toString();
    }

    let namePart = userName.length > 0 ? (", " + userName) : "";

    if (lower === "hello" || lower === "hi" || lower === "hey") {
        return "Hello" + namePart + "! I'm Flopper AI. Type 'help' for commands.";
    }
    if (lower === "bye" || lower === "goodbye" || lower === "see you") {
        return "Goodbye" + namePart + "! Talk again soon.";
    }
    if (lower === "good morning") {
        return "Good morning" + namePart + "!";
    }
    if (lower === "good night" || lower === "goodnight") {
        return "Good night" + namePart + ", sleep well.";
    }
    if (lower === "thanks" || lower === "thank you" || lower === "thx") {
        return "You're welcome" + namePart + "!";
    }
    if (lower === "how are you" || lower === "how's it going") {
        return "I'm just JavaScript on a Flipper Zero, but doing great! How about you?";
    }
    if (lower === "who are you" || lower === "what are you" || lower === "what's your name") {
        return "I'm Flopper AI, an offline assistant running on this Flipper Zero.";
    }
    if (lower === "who made you" || lower === "who created you") {
        return "I'm a custom JavaScript script built for the Flipper Zero.";
    }
    if (lower === "what can you do" || lower === "what do you do") {
        return helpText();
    }
    if (lower === "what's my name" || lower === "what is my name") {
        return userName.length > 0 ? ("Your name is " + userName + "!") : "I don't know your name yet - set it in Options.";
    }
    if (lower === "are you real" || lower === "are you alive") {
        return "Nope, just code! But happy to chat.";
    }
    if (lower === "i love you") {
        return "That's sweet" + namePart + ", but I'm just a script!";
    }
    if (lower === "tell me a joke" || lower === "joke") {
        return randomJoke();
    }
    if (lower === "help") {
        return helpText();
    }
    if (lower === "credits") {
        return creditsText();
    }

    return "I'm an offline bot with limited built-in knowledge.\nType 'help' to see what I can do, or teach me something new.";
}

loadLearnedFacts();
loadUserName();

let navState = {
    returnTarget: null,
    textInputMode: "chat",
};

let dictWords = buildDictionaryWordList();
if (dictWords.length === 0) {
    dictWords.push("(no dictionary.txt found on SD card)");
}
let wikiTopics = buildWikiTopicList();
if (wikiTopics.length === 0) {
    wikiTopics.push("(no wiki.txt found on SD card)");
}

let views = {
    splash: dialogView.makeWith({ header: "Flopper AI", text: "Starting..." }),
    mainMenu: makeSubmenu("Flopper AI", ["Ask / Chat", "Dictionary", "Wikipedia", "Battery", "Options", "Help", "Credits", "Exit"]),
    textInput: textInputView.makeWith({
        header: "Ask or teach me:",
        minLength: 0,
        maxLength: 200,
        defaultText: "",
        defaultTextClear: true,
    }),
    answerBox: textBoxView.makeWith({ focus: "start", font: "text", text: "" }),
    dictionaryMenu: makeSubmenu("Dictionary", dictWords),
    wikiMenu: makeSubmenu("Wikipedia Topics", wikiTopics),
    optionsMenu: makeSubmenu("Options", ["Set your name", "Clear your name"]),
};

eventLoop.subscribe(views.mainMenu.chosen, function (_sub, index, gui, views, navState, eventLoop, flipper) {
    if (index === 0) {
        views.textInput.set("header", "Ask or teach me:");
        views.textInput.set("defaultText", "");
        navState.textInputMode = "chat";
        gui.viewDispatcher.switchTo(views.textInput);
    } else if (index === 1) {
        gui.viewDispatcher.switchTo(views.dictionaryMenu);
    } else if (index === 2) {
        gui.viewDispatcher.switchTo(views.wikiMenu);
    } else if (index === 3) {
        views.answerBox.set("text", "Battery: " + flipper.getBatteryCharge().toString() + "%");
        navState.returnTarget = views.mainMenu;
        gui.viewDispatcher.switchTo(views.answerBox);
    } else if (index === 4) {
        gui.viewDispatcher.switchTo(views.optionsMenu);
    } else if (index === 5) {
        views.answerBox.set("text", helpText());
        navState.returnTarget = views.mainMenu;
        gui.viewDispatcher.switchTo(views.answerBox);
    } else if (index === 6) {
        views.answerBox.set("text", creditsText());
        navState.returnTarget = views.mainMenu;
        gui.viewDispatcher.switchTo(views.answerBox);
    } else if (index === 7) {
        eventLoop.stop();
    }
}, gui, views, navState, eventLoop, flipper);

eventLoop.subscribe(views.dictionaryMenu.chosen, function (_sub, idx, gui, views, navState, dictWords) {
    let word = dictWords[idx];
    let def = lookupDefine(word);
    views.answerBox.set("text", def !== undefined ? (word + ":\n" + def) : ("No entry found for '" + word + "'."));
    navState.returnTarget = views.dictionaryMenu;
    gui.viewDispatcher.switchTo(views.answerBox);
}, gui, views, navState, dictWords);

eventLoop.subscribe(views.wikiMenu.chosen, function (_sub, idx, gui, views, navState, wikiTopics) {
    let topic = wikiTopics[idx];
    let info = lookupWiki(topic);
    views.answerBox.set("text", info !== undefined ? info : ("No article found for '" + topic + "'."));
    navState.returnTarget = views.wikiMenu;
    gui.viewDispatcher.switchTo(views.answerBox);
}, gui, views, navState, wikiTopics);

eventLoop.subscribe(views.optionsMenu.chosen, function (_sub, optIndex, gui, views, navState) {
    if (optIndex === 0) {
        views.textInput.set("header", "What should I call you?");
        views.textInput.set("defaultText", userName);
        navState.textInputMode = "setName";
        gui.viewDispatcher.switchTo(views.textInput);
    } else if (optIndex === 1) {
        saveUserName("");
        views.answerBox.set("text", "Okay, I won't use a name for you.");
        navState.returnTarget = views.optionsMenu;
        gui.viewDispatcher.switchTo(views.answerBox);
    }
}, gui, views, navState);

eventLoop.subscribe(views.textInput.input, function (_sub, rawText, gui, views, navState) {
    let text = replaceUnderscoresWithSpaces(rawText);
    if (navState.textInputMode === "setName") {
        let name = trimStr(text);
        saveUserName(name);
        views.textInput.set("header", "Ask or teach me:");
        navState.textInputMode = "chat";
        views.answerBox.set("text", name.length > 0 ? ("Got it, I'll call you " + name + ".") : "Okay, no name set.");
        navState.returnTarget = views.optionsMenu;
        gui.viewDispatcher.switchTo(views.answerBox);
        return;
    }
    let answer = processQuery(text);
    views.answerBox.set("text", answer);
    navState.returnTarget = views.textInput;
    gui.viewDispatcher.switchTo(views.answerBox);
}, gui, views, navState);

eventLoop.subscribe(gui.viewDispatcher.navigation, function (_sub, _item, gui, views, navState, eventLoop) {
    let cur = gui.viewDispatcher.currentView;
    if (cur === views.mainMenu || cur === views.splash) {
        eventLoop.stop();
        return;
    }
    if (cur === views.answerBox) {
        gui.viewDispatcher.switchTo(navState.returnTarget);
        return;
    }
    gui.viewDispatcher.switchTo(views.mainMenu);
}, gui, views, navState, eventLoop);

gui.viewDispatcher.switchTo(views.splash);
eventLoop.subscribe(eventLoop.timer("oneshot", 1200), function (_sub, _item, gui, views) {
    gui.viewDispatcher.switchTo(views.mainMenu);
}, gui, views);

eventLoop.run();
