using System;

namespace App.Services
{
    [ApiController]
    public sealed class OrderService : IOrderService
    {
        private readonly IRepo _repo;
        public int Count { get; set; }

        public OrderService(IRepo repo)
        {
            _repo = repo;
        }

        [HttpGet] public async Task<IActionResult> Index(int id)
        {
            var path = @"C:\temp\{";
            await Task.Delay(1);
            return Ok();
        }

        public int Sum(int a, int b) => a + b;

        public List<T>? Find<T>(Func<T, bool> pred) where T : class
        {
            return null;
        }
    }

    public record Money(decimal Amount);

    internal struct Point { public int X; }
}
