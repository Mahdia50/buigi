import { sounds } from "./audio.js";
import { fetchFramed } from "./framedClient.js";

class SeenMaghribGame {
  constructor() {
    this.questionsData = { mainCategories: [], allCategories: [], values: [200, 400, 600], questions: [] };
    this.state = {
      mode: "local", // local, room
      roomCode: null,
      teamRed: { name: "الفريق الأحمر", score: 0, lifelines: { fifty: true, call: true, pit: true, pass: true } },
      teamGreen: { name: "الفريق الأخضر", score: 0, lifelines: { fifty: true, call: true, pit: true, pass: true } },
      currentTurn: "red",
      selectedCategories: [],
      grid: [],
      activeCell: null,
      timerDuration: 30,
      timerRemaining: 30,
      timerInterval: null,
      isAnswerRevealed: false,
      log: []
    };

    this.eventSource = null;
  }

  async init() {
    this.bindEvents();
    await this.loadQuestions();
    this.setupDefaultGame();
    this.render();
    this.renderBank();
  }

  async loadQuestions() {
    try {
      const res = await fetch("/api/questions");
      this.questionsData = await res.json();
    } catch (e) {
      console.warn("Failed to fetch questions from server, using empty dataset", e);
    }
  }

  setupDefaultGame(categories = null) {
    const cats = categories || this.questionsData.mainCategories.map(c => c.id);
    this.state.selectedCategories = cats.slice(0, 6);

    // إنشاء شبكة 18 خانة (6 فئات × 3 قيم)
    this.state.grid = [];
    for (const catId of this.state.selectedCategories) {
      for (const val of [200, 400, 600]) {
        // العثور على سؤال يطابق الفئة والقيمة
        const matchingQuestions = this.questionsData.questions.filter(q => q.category === catId && q.value === val);
        const randomQ = matchingQuestions.length > 0 
          ? matchingQuestions[Math.floor(Math.random() * matchingQuestions.length)]
          : { id: `${catId}-${val}`, category: catId, value: val, text: `سؤال في ${catId}`, answer: "المغرب" };

        this.state.grid.push({
          id: `${catId}-${val}`,
          categoryId: catId,
          value: val,
          question: randomQ,
          status: "available", // available, active, completed
          wonBy: null
        });
      }
    }

    this.state.teamRed.score = 0;
    this.state.teamGreen.score = 0;
    this.state.teamRed.lifelines = { fifty: true, call: true, pit: true, pass: true };
    this.state.teamGreen.lifelines = { fifty: true, call: true, pit: true, pass: true };
    this.state.currentTurn = "red";
    this.state.log = [{ text: "بدأت مباراة جديدة! الدور للفريق الأحمر." }];
  }

  bindEvents() {
    // تبديل الصوت
    const soundBtn = document.getElementById("soundToggleBtn");
    if (soundBtn) {
      soundBtn.addEventListener("click", () => {
        const isMuted = sounds.toggleMute();
        soundBtn.textContent = isMuted ? "🔇 غير مفعّل" : "🔊 الصوت مفعّل";
      });
    }

    // إظهار الجواب
    const revealBtn = document.getElementById("revealAnswerBtn");
    if (revealBtn) {
      revealBtn.addEventListener("click", () => {
        this.revealAnswer();
      });
    }

    // خيارات التقييم
    document.getElementById("btnScoreRed")?.addEventListener("click", () => this.resolveActiveQuestion("red"));
    document.getElementById("btnScoreGreen")?.addEventListener("click", () => this.resolveActiveQuestion("green"));
    document.getElementById("btnScorePass")?.addEventListener("click", () => this.resolveActiveQuestion("none"));

    // إعداد مباراة جديدة
    document.getElementById("startNewGameBtn")?.addEventListener("click", () => {
      const redName = document.getElementById("setupRedName")?.value.trim() || "الفريق الأحمر";
      const greenName = document.getElementById("setupGreenName")?.value.trim() || "الفريق الأخضر";
      this.state.teamRed.name = redName;
      this.state.teamGreen.name = greenName;

      // جمع الفئات المختارة
      const checkboxes = document.querySelectorAll("#categoryCheckboxes input[type='checkbox']:checked");
      const chosen = Array.from(checkboxes).map(cb => cb.value);
      this.setupDefaultGame(chosen.length === 6 ? chosen : null);
      this.switchTab("game");
      this.render();
      sounds.playFlip();
    });

    // وضع البث المباشر
    document.getElementById("toggleBroadcastBtn")?.addEventListener("click", () => {
      document.body.classList.toggle("broadcast-mode");
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    });

    // تبويبات التنقل
    document.querySelectorAll("[data-tab]").forEach(el => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const tab = el.getAttribute("data-tab");
        this.switchTab(tab);
      });
    });

    // وسائل المساعدة للفرق
    document.querySelectorAll("[data-lifeline]").forEach(btn => {
      btn.addEventListener("click", () => {
        const team = btn.getAttribute("data-team");
        const lifeline = btn.getAttribute("data-lifeline");
        this.useLifeline(team, lifeline);
      });
    });

    // إغلاق النافذة المنبثقة
    document.getElementById("closeModalBtn")?.addEventListener("click", () => {
      this.closeModal();
    });
  }

  switchTab(tabId) {
    document.querySelectorAll(".tab-content").forEach(el => el.classList.remove("active"));
    document.getElementById(`tab-${tabId}`)?.classList.add("active");
  }

  getCategoryInfo(categoryId) {
    return this.questionsData.allCategories.find(c => c.id === categoryId) || { id: categoryId, name: categoryId, emoji: "🇲🇦" };
  }

  render() {
    this.renderScoreboard();
    this.renderGrid();
    this.renderLog();
    this.populateSetupCategories();
  }

  renderScoreboard() {
    // الفريق الأحمر
    const redNameEl = document.getElementById("scoreTeamRedName");
    const redScoreEl = document.getElementById("scoreTeamRed");
    const redCard = document.getElementById("teamCardRed");
    if (redNameEl) redNameEl.textContent = this.state.teamRed.name;
    if (redScoreEl) redScoreEl.textContent = this.state.teamRed.score.toLocaleString("ar-MA");

    // الفريق الأخضر
    const greenNameEl = document.getElementById("scoreTeamGreenName");
    const greenScoreEl = document.getElementById("scoreTeamGreen");
    const greenCard = document.getElementById("teamCardGreen");
    if (greenNameEl) greenNameEl.textContent = this.state.teamGreen.name;
    if (greenScoreEl) greenScoreEl.textContent = this.state.teamGreen.score.toLocaleString("ar-MA");

    // مؤشر الدور الحالي
    if (this.state.currentTurn === "red") {
      redCard?.classList.add("active-turn");
      greenCard?.classList.remove("active-turn");
    } else {
      greenCard?.classList.add("active-turn");
      redCard?.classList.remove("active-turn");
    }

    // وسائل المساعدة
    ["fifty", "call", "pit", "pass"].forEach(l => {
      const redBtn = document.querySelector(`[data-team="red"][data-lifeline="${l}"]`);
      if (redBtn) redBtn.disabled = !this.state.teamRed.lifelines[l];
      const greenBtn = document.querySelector(`[data-team="green"][data-lifeline="${l}"]`);
      if (greenBtn) greenBtn.disabled = !this.state.teamGreen.lifelines[l];
    });
  }

  renderGrid() {
    const gridContainer = document.getElementById("gameBoardGrid");
    if (!gridContainer) return;
    gridContainer.innerHTML = "";

    // 1. ترويسات الفئات الستة (الصف الأول)
    for (const catId of this.state.selectedCategories) {
      const cat = this.getCategoryInfo(catId);
      const colHeader = document.createElement("div");
      colHeader.className = "category-header";
      colHeader.innerHTML = `
        <div class="category-emoji">${cat.emoji}</div>
        <div class="category-title" title="${cat.name}">${cat.name}</div>
      `;
      gridContainer.appendChild(colHeader);
    }

    // 2. خانات القيم (200, 400, 600)
    for (const val of [200, 400, 600]) {
      for (const catId of this.state.selectedCategories) {
        const cell = this.state.grid.find(c => c.categoryId === catId && c.value === val);
        const cellEl = document.createElement("div");
        cellEl.className = "grid-cell";

        if (cell.status === "completed") {
          cellEl.classList.add("completed");
          if (cell.wonBy === "red") cellEl.classList.add("won-red");
          if (cell.wonBy === "green") cellEl.classList.add("won-green");
          cellEl.textContent = cell.wonBy === "red" ? "✓ أحمر" : cell.wonBy === "green" ? "✓ أخضر" : "—";
        } else {
          cellEl.textContent = val;
          cellEl.addEventListener("click", () => this.openQuestion(cell));
        }

        gridContainer.appendChild(cellEl);
      }
    }
  }

  openQuestion(cell) {
    this.state.activeCell = cell;
    this.state.isAnswerRevealed = false;
    sounds.playFlip();

    const cat = this.getCategoryInfo(cell.categoryId);
    document.getElementById("modalCatBadge").textContent = `${cat.emoji} ${cat.name} · ${cell.value} نقطة`;
    document.getElementById("modalQuestionText").textContent = cell.question.text;
    document.getElementById("modalAnswerText").textContent = cell.question.answer + (cell.question.alt?.length ? ` (أو: ${cell.question.alt.join(" / ")})` : "");
    
    document.getElementById("answerBox")?.classList.remove("revealed");
    document.getElementById("lifelineHintBox")?.classList.add("hidden");

    this.startTimer(this.state.timerDuration);

    const modal = document.getElementById("questionModal");
    modal?.classList.add("open");
  }

  startTimer(seconds) {
    this.stopTimer();
    this.state.timerRemaining = seconds;
    const bar = document.getElementById("timerBar");
    const countEl = document.getElementById("timerCountdown");

    const updateUI = () => {
      const pct = (this.state.timerRemaining / seconds) * 100;
      if (bar) {
        bar.style.width = `${pct}%`;
        bar.classList.toggle("danger", this.state.timerRemaining <= 10);
      }
      if (countEl) countEl.textContent = `${this.state.timerRemaining} ثانية`;
    };

    updateUI();

    this.state.timerInterval = setInterval(() => {
      this.state.timerRemaining--;
      sounds.playTick();
      updateUI();

      if (this.state.timerRemaining <= 0) {
        this.stopTimer();
        sounds.playWrong();
      }
    }, 1000);
  }

  stopTimer() {
    if (this.state.timerInterval) {
      clearInterval(this.state.timerInterval);
      this.state.timerInterval = null;
    }
  }

  revealAnswer() {
    this.state.isAnswerRevealed = true;
    document.getElementById("answerBox")?.classList.add("revealed");
    this.stopTimer();
  }

  resolveActiveQuestion(wonBy) {
    if (!this.state.activeCell) return;
    this.stopTimer();

    const cell = this.state.activeCell;
    cell.status = "completed";
    cell.wonBy = wonBy;

    if (wonBy === "red") {
      this.state.teamRed.score += cell.value;
      sounds.playCorrect();
      this.state.log.unshift({ text: `+${cell.value} نقطة لـ ${this.state.teamRed.name}!` });
    } else if (wonBy === "green") {
      this.state.teamGreen.score += cell.value;
      sounds.playCorrect();
      this.state.log.unshift({ text: `+${cell.value} نقطة لـ ${this.state.teamGreen.name}!` });
    } else {
      sounds.playWrong();
      this.state.log.unshift({ text: `خانة ${cell.value} نقطة بدون فائز.` });
    }

    // تبديل الدور
    this.state.currentTurn = this.state.currentTurn === "red" ? "green" : "red";
    this.closeModal();
    this.render();

    // التحقق من نهاية المباراة
    const allDone = this.state.grid.every(c => c.status === "completed");
    if (allDone) {
      this.triggerWinnerCelebration();
    }
  }

  closeModal() {
    this.stopTimer();
    this.state.activeCell = null;
    document.getElementById("questionModal")?.classList.remove("open");
  }

  useLifeline(team, lifeline) {
    const targetTeam = team === "red" ? this.state.teamRed : this.state.teamGreen;
    if (!targetTeam.lifelines[lifeline]) return;

    targetTeam.lifelines[lifeline] = false;
    const hintBox = document.getElementById("lifelineHintBox");
    const hintText = document.getElementById("lifelineHintText");

    if (lifeline === "fifty") {
      // جاوب بجوج: إظهار خيارين أحدهما صحيح والآخر بديل
      const q = this.state.activeCell?.question;
      if (q && hintBox && hintText) {
        hintBox.classList.remove("hidden");
        const fakeAnswer = "خيار بديل / غير صحيح";
        hintText.innerHTML = `<strong>جاوب بجوج:</strong> إما <u>${q.answer}</u> أو <u>${fakeAnswer}</u>`;
      }
    } else if (lifeline === "call") {
      // اتصال بصاحبك: إعادة تشغيل مؤقت إضافي 30 ثانية
      this.startTimer(30);
    } else if (lifeline === "pit") {
      // الحفرة: تحدي مضاعفة النقاط!
      if (this.state.activeCell) {
        this.state.activeCell.value *= 2;
        alert("⚠️ الحفرة مفعّلة! قيمة السؤال تضاعفت الآن إلى " + this.state.activeCell.value + " نقطة!");
      }
    } else if (lifeline === "pass") {
      // استريح: تخطي السؤال
      this.resolveActiveQuestion("none");
    }

    this.renderScoreboard();
  }

  triggerWinnerCelebration() {
    sounds.playVictory();
    const winner = this.state.teamRed.score > this.state.teamGreen.score 
      ? this.state.teamRed.name 
      : this.state.teamGreen.score > this.state.teamRed.score 
      ? this.state.teamGreen.name 
      : "تعادل رائع بين الفريقين";

    setTimeout(() => {
      alert(`🏆 مبروك! انتهت المباراة.\nالفائز: ${winner}\nالنتيجة: ${this.state.teamRed.name} (${this.state.teamRed.score}) - ${this.state.teamGreen.name} (${this.state.teamGreen.score})`);
    }, 500);
  }

  renderLog() {
    const list = document.getElementById("activityLogList");
    if (!list) return;
    list.innerHTML = this.state.log.slice(0, 8).map(l => `
      <li style="padding: 0.35rem 0; border-bottom: 1px dashed rgba(0,0,0,0.08); font-size: 0.85rem;">
        ${l.text}
      </li>
    `).join("");
  }

  populateSetupCategories() {
    const container = document.getElementById("categoryCheckboxes");
    if (!container || container.children.length > 0) return;

    this.questionsData.allCategories.forEach((cat, idx) => {
      const label = document.createElement("label");
      label.style = "display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; cursor: pointer;";
      label.innerHTML = `
        <input type="checkbox" value="${cat.id}" ${idx < 6 ? "checked" : ""} />
        <span>${cat.emoji} ${cat.name}</span>
      `;
      container.appendChild(label);
    });
  }

  renderBank() {
    const list = document.getElementById("bankQuestionsList");
    const countEl = document.getElementById("bankTotalCount");
    if (countEl) countEl.textContent = this.questionsData.questions.length;
    if (!list) return;

    const renderItems = (items) => {
      list.innerHTML = items.slice(0, 50).map(q => {
        const cat = this.getCategoryInfo(q.category);
        return `
          <div style="background: #fff; border: 2px solid #211A16; border-radius: 12px; padding: 0.85rem; margin-bottom: 0.6rem; box-shadow: 0 3px 0 #211A16;">
            <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: #BC5A36; font-weight: 700; margin-bottom: 0.3rem;">
              <span>${cat.emoji} ${cat.name}</span>
              <span>${q.value} نقطة</span>
            </div>
            <div style="font-weight: 800; font-size: 1rem; color: #211A16; margin-bottom: 0.35rem;">${q.text}</div>
            <div style="font-size: 0.85rem; color: #2D6A4F; font-weight: 700;">الجواب: ${q.answer}</div>
          </div>
        `;
      }).join("");
    };

    renderItems(this.questionsData.questions);

    document.getElementById("bankSearchInput")?.addEventListener("input", (e) => {
      const term = e.target.value.toLowerCase().trim();
      const filtered = this.questionsData.questions.filter(q => 
        q.text.toLowerCase().includes(term) || q.answer.toLowerCase().includes(term) || q.category.toLowerCase().includes(term)
      );
      renderItems(filtered);
    });
  }
}

const game = new SeenMaghribGame();
window.addEventListener("DOMContentLoaded", () => game.init());
