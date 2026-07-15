import sys
from playwright.sync_api import sync_playwright

CDP_URL = "http://localhost:9222"


def run(playwright, keyword: str) -> None:
    browser = playwright.chromium.connect_over_cdp(CDP_URL)
    ctx = browser.contexts[0]

    page = next(
        (pg for pg in ctx.pages if "webcustomer" in pg.url),
        ctx.pages[0] if ctx.pages else None,
    )
    if not page:
        print("找不到 IM 页面，请确认 daemon 已登录")
        return

    print(f"已连接，当前页面: {page.url}")

    # 点击 search2.svg 图标，会弹出新页签
    search_img = page.locator('img[src="/webcustomer/static/img/commonLan/search2.svg"]')
    print(f"找到搜索图标: {search_img.count()} 个")

    with ctx.expect_page() as new_page_info:
        search_img.first.click()

    new_tab = new_page_info.value
    new_tab.wait_for_load_state("domcontentloaded")
    print(f"新页签已打开: {new_tab.url}")

    # 系统域名是第一个 input.bwd-input，placeholder 为"支持模糊查询"
    system_input = new_tab.locator('input.bwd-input').first
    system_input.click()
    system_input.fill(keyword)
    print(f"已输入系统域名: {keyword}")

    # 查询按钮文字为"查 询"（中间有空格）
    new_tab.get_by_role("button", name="查 询").click()
    print("已点击查询按钮")

    new_tab.wait_for_timeout(3000)

    results = new_tab.evaluate("""
    () => {
        const headers = Array.from(document.querySelectorAll('table thead th')).map(th => th.textContent?.trim());
        const rows = document.querySelectorAll('table tbody tr');
        const data = [];
        rows.forEach((row) => {
            const cells = row.querySelectorAll('td');
            if (cells.length > 0) {
                const rowData = {};
                cells.forEach((cell, i) => {
                    if (headers[i]) rowData[headers[i]] = cell.textContent?.trim();
                });
                data.push(rowData);
            }
        });
        return JSON.stringify({ headers, count: data.length, data }, null, 2);
    }
    """)
    print(f"查询结果:\n{results}")

    # 关闭新页签
    new_tab.close()
    print("新页签已关闭")

    # 断开连接（不会关闭浏览器，daemon 继续运行）
    browser.close()
    print("worker 已断开连接")


if __name__ == "__main__":
    keyword = sys.argv[1] if len(sys.argv) > 1 else "pcsp"
    with sync_playwright() as playwright:
        run(playwright, keyword)
