<!doctype html>
<p>Don't function html_text() { here</p>
<?php
namespace App\Http;

# comment function nope() {}
abstract class Controller
{
    public function __construct(private Repo $repo) {}

    public static function index(Request $request): Response
    {
        $sql = 'SELECT { FROM t';
        $html = <<<HTML
        <div>function inHeredoc() {</div>
        HTML;
        return new Response($sql);
    }

    abstract protected function handle();
}

function helper($x) {
    return $x;
}
?>
<div><?= helper(1) ?></div>
